import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'worker/agents/planning/designDna.test.ts',
			'worker/agents/prompts.test.ts',
		],
		environment: 'node',
		globals: true,
	},
});
