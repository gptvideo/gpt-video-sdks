import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The API key of a GPT-Video account. n8n adds it to each request of the node as `Authorization: Bearer`, and
 * the node itself never reads it.
 */
export class GptVideoApi implements ICredentialType {
	name = 'gptVideoApi';

	displayName = 'GPT-Video API';

	icon: Icon = { light: 'file:../icons/gptVideo.svg', dark: 'file:../icons/gptVideo.dark.svg' };

	documentationUrl = 'https://www.gpt-video.com/developers/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'An API key of your account. It starts with gvk_. Create one on the Developers page of the GPT-Video app.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.gpt-video.com/v1',
			description: 'Leave it as it is. Change it only to reach a test server: https://, or http:// for an address on this machine.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ $credentials.baseUrl.replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1" }}',
			url: '/me',
		},
	};
}
