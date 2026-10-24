"""GPT-Video quickstart: from a video file to a vertical clip on your disk.

    pip install gpt-video
    export GPT_VIDEO_API_KEY=gvk_...
    python quickstart.py talk.mp4

Steps 1 to 4 use no credits. Step 5 spends credits: one per started minute of the video.
Step 7 uses one export of your daily allowance, and one API bonus credit while the bonus pays.
"""

import os
import sys

from gpt_video import GptVideo, GptVideoError


def spend_once(call):
    """A call that spends and ends without a clear answer (the network failed, or the time ran out) may have been
    charged. Calling again with the same idempotency_key returns the first answer and never pays twice."""
    try:
        return call(None)
    except GptVideoError as error:
        if not error.may_have_spent:
            raise
        print(f"No clear answer ({error.code}). Asking again with the same Idempotency-Key.")
        return call(error.idempotency_key)


def main(path):
    gv = GptVideo()  # reads GPT_VIDEO_API_KEY

    # 1. Check the key.
    me = gv.get_me()
    print(f"Key {me['key']['id']} works. Scopes: {', '.join(me['key']['scopes'])}. Plan: {me['account']['plan']}.")

    # 2. Upload the video. The SDK sends it in parts and reads one part at a time from the disk.
    asset = gv.upload_file(path, on_progress=lambda p: print(f"Uploaded {round(100 * p.uploaded_bytes / p.total_bytes)}%"))["asset"]
    print(f"Video {asset['id']} is ready.")

    # 3. Create an Auto Clip project. Auto Clip has no default settings: the analysis starts only when
    # missingSettings is empty, so choose every one of them.
    project = gv.create_project(
        sourceAssetId=asset["id"],
        title=os.path.basename(path),
        settings={
            "language": "auto",
            "clipCount": 3,
            "minDurationSec": 15,
            "maxDurationSec": 60,
            "objective": "viral",
            "captionStyle": "word-pop",
            "reframe": "face",
        },
    )["project"]
    if project["missingSettings"]:
        raise SystemExit(f"Settings still to choose: {', '.join(project['missingSettings'])}")

    # 4. Ask the price of the analysis.
    estimate = gv.estimate_analysis(projectId=project["id"])["estimate"]
    print(f"The analysis costs {estimate['creditsToCharge']} credits.")
    if not estimate["enough"]:
        raise SystemExit("The account cannot pay for it. See https://www.gpt-video.com/developers/pricing")

    # 5. Analyze the video, and wait until its clips are found.
    analysis = spend_once(lambda key: gv.analyze_project(projectId=project["id"], idempotency_key=key))
    print(f"Analysis started ({analysis['creditsCharged']} credits charged). Waiting for job {analysis['job']['id']}.")
    gv.wait(analysis)

    # 6. Read the clips in the order the analysis ranked them, and accept the first one. Accepting makes a
    # composition, whose framing follows the face of the speaker; it can be exported once its framing job is done.
    clips = list(gv.paginate("list_clips", projectId=project["id"], status="proposed"))
    for clip in clips:
        print(f"{clip['rank'] + 1}. {clip['title']} ({clip['startSec']}s to {clip['endSec']}s, score {clip['score']})")
    if not clips:
        raise SystemExit("The analysis found no clips in this video.")
    composition = gv.accept_clip(clipId=clips[0]["id"])["composition"]
    if composition["framing"]["jobId"]:
        gv.wait_for_job(composition["framing"]["jobId"])

    # 7. Export the composition to an MP4 file, wait for it, and download it. The download link is its own
    # credential: the SDK never sends your API key to it.
    exported = spend_once(lambda key: gv.create_export(compositionId=composition["id"], idempotency_key=key))
    done = gv.wait(exported)
    size = gv.download(done["downloadUrl"], "clip.mp4")
    print(f"Saved clip.mp4 ({size} bytes).")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python quickstart.py <video file>")
    main(sys.argv[1])
