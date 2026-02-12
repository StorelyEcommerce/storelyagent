import { describe, expect, it } from 'vitest';
import source from './UserConversationProcessor.ts?raw';

describe('storely conversational prompt', () => {
	it('uses Storely platform framing', () => {
		expect(source).toContain("Storely's store-building platform");
		expect(source).not.toContain("Cloudflare's vibe coding platform");
	});
});
