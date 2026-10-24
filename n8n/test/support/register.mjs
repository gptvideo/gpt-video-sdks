// Loads the tests' stand-in for n8n-workflow in place of the real package, so the tests run the same with or
// without n8n installed: the classes the node throws, the sleep it pauses with, the connection type it names.
// The real package is what the type check and a run in a real n8n use.
import { registerHooks } from 'node:module';

const FAKE = new URL('./fake-n8n-workflow.mts', import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'n8n-workflow') return { url: FAKE, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
