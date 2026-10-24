"""The package as it is published: pyproject.toml, the version, the names it exports, what it imports, the Python
it runs on, and the text of every file."""

import ast
import json
import re
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple

import gpt_video
from gpt_video import webhooks
from gpt_video._transport import USER_AGENT_PRODUCT, resolve_settings
from gpt_video._version import VERSION
from gpt_video.errors import WebhookVerificationError

from .support import api_key

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "src" / "gpt_video"


# ------------------------------------------------------------------------------------------- pyproject.toml


class _Toml:
    """The part of TOML that pyproject.toml uses: tables, and keys whose values are strings, booleans, whole
    numbers, lists and inline tables. Python 3.10 has no tomllib; on a newer Python the test checks that this
    reader and tomllib read the file the same way. Anything else raises."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.at = 0

    def fail(self, why: str) -> Exception:
        line = self.text.count("\n", 0, self.at) + 1
        return ValueError(f"pyproject.toml, line {line}: {why}")

    def space(self, newlines: bool) -> None:
        while self.at < len(self.text):
            c = self.text[self.at]
            if c in " \t" or (newlines and c in "\r\n"):
                self.at += 1
            elif c == "#":
                while self.at < len(self.text) and self.text[self.at] != "\n":
                    self.at += 1
            else:
                return

    def key(self) -> str:
        if self.text[self.at] == '"':
            return self.string()
        m = re.compile(r"[A-Za-z0-9_-]+").match(self.text, self.at)
        if not m:
            raise self.fail("a key was expected")
        self.at = m.end()
        return m.group()

    def dotted(self) -> List[str]:
        parts = [self.key()]
        while self.text.startswith(".", self.at):
            self.at += 1
            parts.append(self.key())
        return parts

    def string(self) -> str:
        m = re.compile(r'"((?:[^"\\\n]|\\.)*)"').match(self.text, self.at)
        if not m:
            raise self.fail("a string was expected")
        self.at = m.end()
        return json.loads(f'"{m.group(1)}"')

    def value(self) -> Any:
        c = self.text[self.at]
        if c == '"':
            return self.string()
        if c == "[":
            self.at += 1
            items: List[Any] = []
            while True:
                self.space(True)
                if self.text.startswith("]", self.at):
                    self.at += 1
                    return items
                items.append(self.value())
                self.space(True)
                if self.text.startswith(",", self.at):
                    self.at += 1
                elif not self.text.startswith("]", self.at):
                    raise self.fail("a comma or ] was expected")
        if c == "{":
            self.at += 1
            table: Dict[str, Any] = {}
            while True:
                self.space(False)
                if self.text.startswith("}", self.at):
                    self.at += 1
                    return table
                name = self.key()
                self.space(False)
                if not self.text.startswith("=", self.at):
                    raise self.fail("= was expected")
                self.at += 1
                self.space(False)
                table[name] = self.value()
                self.space(False)
                if self.text.startswith(",", self.at):
                    self.at += 1
        for word, meaning in (("true", True), ("false", False)):
            if self.text.startswith(word, self.at):
                self.at += len(word)
                return meaning
        m = re.compile(r"[0-9]+").match(self.text, self.at)
        if m:
            self.at = m.end()
            return int(m.group())
        raise self.fail("a value this reader knows was expected")

    def read(self) -> Dict[str, Any]:
        document: Dict[str, Any] = {}
        current = document
        while True:
            self.space(True)
            if self.at >= len(self.text):
                return document
            if self.text.startswith("[", self.at):
                self.at += 1
                current = document
                for part in self.dotted():
                    current = current.setdefault(part, {})
                if not self.text.startswith("]", self.at):
                    raise self.fail("] was expected")
                self.at += 1
                continue
            path = self.dotted()
            self.space(False)
            if not self.text.startswith("=", self.at):
                raise self.fail("= was expected")
            self.at += 1
            self.space(False)
            target = current
            for part in path[:-1]:
                target = target.setdefault(part, {})
            target[path[-1]] = self.value()


PYPROJECT_TEXT = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
PYPROJECT = _Toml(PYPROJECT_TEXT).read()


class Pyproject(unittest.TestCase):
    def test_the_reader_reads_the_file_as_tomllib_does_where_tomllib_exists(self) -> None:
        try:
            import tomllib
        except ImportError:
            # Python 3.10 has no tomllib: there the reader of this file is the only one, and its cases below stand
            self.assertEqual(sys.version_info[:2], (3, 10))
        else:
            self.assertEqual(PYPROJECT, tomllib.loads(PYPROJECT_TEXT))
        with self.assertRaises(ValueError):
            _Toml("a = 1.5\n").read()
        self.assertEqual(_Toml('[x.y]\nz = ["a", "b",]\nw = { n = "v", e = true }\n').read(), {"x": {"y": {"z": ["a", "b"], "w": {"n": "v", "e": True}}}})

    def test_names_the_package_needs_python_3_10_and_depends_on_nothing(self) -> None:
        project = PYPROJECT["project"]
        self.assertEqual(project["name"], "gpt-video")
        self.assertEqual(project["requires-python"], ">=3.10")
        self.assertEqual(project["dependencies"], [])
        self.assertNotIn("optional-dependencies", project)
        self.assertEqual(project["license"], "MIT")
        self.assertEqual(project["authors"], [{"name": "GPT-Video", "email": "hello@gpt-video.com"}])
        self.assertEqual(project["readme"], "README.md")
        self.assertIn("Programming Language :: Python :: 3.10", project["classifiers"])
        self.assertIn("Typing :: Typed", project["classifiers"])

    def test_takes_its_version_from_the_one_place_it_is_written(self) -> None:
        self.assertEqual(PYPROJECT["project"]["dynamic"], ["version"])
        self.assertNotIn("version", PYPROJECT["project"])
        self.assertEqual(PYPROJECT["tool"]["hatch"]["version"]["path"], "src/gpt_video/_version.py")
        self.assertEqual(PYPROJECT["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"], ["src/gpt_video"])
        self.assertTrue((ROOT / PYPROJECT["tool"]["hatch"]["version"]["path"]).is_file())

    def test_leaves_the_addresses_of_the_project_to_the_release(self) -> None:
        # the links to the repository are written when the package is prepared for release, from one setting
        # (the export refuses a source that already has them), so this test runs in both trees
        urls = PYPROJECT["project"].get("urls")
        if urls is not None:
            self.assertEqual(sorted(urls), ["Homepage", "Issues", "Repository"])
            self.assertTrue(urls["Repository"].endswith("/gpt-video-sdks"))


class Version(unittest.TestCase):
    def test_is_one_version_in_the_package_and_in_every_request(self) -> None:
        self.assertRegex(VERSION, r"^\d+\.\d+\.\d+$")
        self.assertEqual(gpt_video.__version__, VERSION)
        self.assertEqual(gpt_video.VERSION, VERSION)
        self.assertEqual(resolve_settings(api_key=api_key()).user_agent, f"{USER_AGENT_PRODUCT}/{VERSION}")


class PublicNames(unittest.TestCase):
    def test_gpt_video_exports_the_client_the_errors_and_the_events_of_its_hooks(self) -> None:
        self.assertEqual(set(gpt_video.__all__), {"GptVideo", "GptVideoApiError", "GptVideoError", "GptVideoJobError", "GptVideoNetworkError", "RateLimit", "ResponseEvent", "RetryEvent", "UploadProgress", "VERSION", "__version__"})
        for name in gpt_video.__all__:
            self.assertTrue(hasattr(gpt_video, name), name)

    def test_the_webhooks_module_exports_the_two_functions_the_standard_webhooks_class_and_its_error(self) -> None:
        self.assertEqual(set(webhooks.__all__), {"VerifiedWebhook", "Webhook", "WebhookVerificationError", "construct_event", "verify_webhook"})
        self.assertIs(webhooks.WebhookVerificationError, WebhookVerificationError)
        self.assertTrue(issubclass(WebhookVerificationError, gpt_video.GptVideoError))


def sources() -> List[Path]:
    files = sorted(PACKAGE.rglob("*.py")) + sorted((ROOT / "tests").rglob("*.py"))
    assert len(files) > 20, "the scan found almost no files"
    return files


class PythonVersions(unittest.TestCase):
    def test_every_file_is_written_in_the_grammar_of_python_3_10(self) -> None:
        for path in sources():
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path), feature_version=(3, 10))

    def test_no_f_string_uses_a_form_that_python_3_10_cannot_read(self) -> None:
        # feature_version does not see these: an f-string that reuses its own quote, or a backslash, inside a {}
        # expression reads on Python 3.12 and later only. On 3.10 and 3.11 the file would not even parse.
        if sys.version_info < (3, 12):
            return
        checked = 0
        for path in sources():
            text = path.read_text(encoding="utf-8")
            for node in ast.walk(ast.parse(text)):
                if not isinstance(node, ast.JoinedStr):
                    continue
                segment = ast.get_source_segment(text, node) or ""
                quote = re.match(r"[A-Za-z]*('''|\"\"\"|'|\")", segment)
                if not quote:
                    continue
                for part in node.values:
                    if isinstance(part, ast.FormattedValue):
                        inner = ast.get_source_segment(text, part.value) or ""
                        self.assertNotIn(quote.group(1), inner, f"{path.name}: {segment}")
                        self.assertNotIn("\\", inner, f"{path.name}: {segment}")
                        checked += 1
        self.assertGreater(checked, 50, "the scan found almost no f-string expressions")
        with self.assertRaises(AssertionError):
            self.assertNotIn('"', ast.get_source_segment('f"{x["a"]}"', ast.parse('f"{x["a"]}"').body[0].value.values[0].value) or "")  # type: ignore[attr-defined]

    def test_the_package_uses_nothing_newer_than_python_3_10(self) -> None:
        newer = re.compile(r"\b(tomllib|ExceptionGroup|TaskGroup|LiteralString|NotRequired|Required\[|Unpack|Self\b|StrEnum|strict_mode|datetime\.UTC|get_overloads|file_digest|except\*)")
        for path in sorted(PACKAGE.rglob("*.py")):
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                self.assertIsNone(newer.search(line), f"{path.name}:{number}: {line.strip()}")

    def test_the_package_imports_only_the_standard_library_and_itself(self) -> None:
        stdlib = set(sys.stdlib_module_names)
        for path in sorted(PACKAGE.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names = [node.module]
                else:
                    continue
                for name in names:
                    self.assertIn(name.split(".")[0], stdlib, f"{path.name} imports {name}")

    def test_is_typed(self) -> None:
        self.assertTrue((PACKAGE / "py.typed").is_file())


class Text(unittest.TestCase):
    """Every file of the package is text for the people who use it: no internal name, no secret."""

    INTERNAL = re.compile("|".join(["vir" + "ality", "co" + "pilot", r"\bco" + r"dex\b"]), re.IGNORECASE)
    SECRET = re.compile("|".join(["gv" + "k_[A-Za-z0-9_-]{20,}", "wh" + "sec_[A-Za-z0-9+/=]{24,}"]))

    def test_no_file_holds_an_internal_name_or_a_secret(self) -> None:
        scanned = 0
        for path in sorted(p for p in ROOT.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
            data = path.read_bytes()
            if b"\0" in data:
                continue
            text = data.decode("utf-8")
            scanned += 1
            self.assertIsNone(self.INTERNAL.search(text), path.name)
            self.assertIsNone(self.SECRET.search(text), path.name)
        self.assertGreater(scanned, 20)
