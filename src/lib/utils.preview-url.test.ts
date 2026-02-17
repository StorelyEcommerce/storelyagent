import { describe, expect, it } from 'vitest';
import { getPreviewUrl, getPreviewUrlCandidates } from './utils';

describe('preview URL resolution', () => {
	it('normalizes invalid local hostname token characters', () => {
		const input = 'http://8001-sandbox-abcd_efghijklmnop.localhost:5173/';
		const candidates = getPreviewUrlCandidates(input, undefined, 'http://localhost:5173');

		expect(candidates[0]).toBe('http://8001-sandbox-abcd-efghijklmnop.localhost:5173/');
		expect(candidates).toContain(input);
	});

	it('aligns local preview port to current app origin', () => {
		const input = 'http://8001-sandbox-abcdefghijklmnop.localhost:5173/';
		const candidates = getPreviewUrlCandidates(input, undefined, 'http://localhost:5174');

		expect(candidates[0]).toBe('http://8001-sandbox-abcdefghijklmnop.localhost:5174/');
		expect(candidates).toContain(input);
	});

	it('prefers preview URL but falls back to tunnel URL', () => {
		expect(getPreviewUrl(undefined, 'https://my-tunnel.trycloudflare.com')).toBe(
			'https://my-tunnel.trycloudflare.com/'
		);
	});
});
