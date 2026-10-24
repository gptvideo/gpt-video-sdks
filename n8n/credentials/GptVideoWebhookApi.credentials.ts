import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The signing secret of one GPT-Video webhook, which the GPT-Video Trigger checks every event against. It is not
 * sent anywhere: the trigger tests it by its form when the credential is saved, because a secret can only be
 * proved right by an event that was signed with it.
 */
export class GptVideoWebhookApi implements ICredentialType {
	name = 'gptVideoWebhookApi';

	displayName = 'GPT-Video Webhook API';

	icon: Icon = { light: 'file:../icons/gptVideo.svg', dark: 'file:../icons/gptVideo.dark.svg' };

	documentationUrl = 'https://www.gpt-video.com/developers/webhooks';

	properties: INodeProperties[] = [
		{
			displayName: 'Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'The secret of the webhook, as the Developers page of the GPT-Video app shows it. It starts with whsec_.',
		},
	];
}
