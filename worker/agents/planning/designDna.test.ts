import { describe, expect, test } from 'vitest';
import { extractStyleSignalsFromPrompt } from './styleSignals';

describe('extractStyleSignalsFromPrompt', () => {
	test('extracts multiple distinct style cues from user prompt text', () => {
		const prompt = 'Build a premium elegant fashion store with minimalist clean layouts and playful colorful accents.';
		const signals = extractStyleSignalsFromPrompt(prompt);

		expect(signals).toContain('luxury/editorial');
		expect(signals).toContain('minimalist');
		expect(signals).toContain('playful');
	});

	test('deduplicates repeated cues', () => {
		const prompt = 'Minimal minimalist clean simple airy layout please';
		const signals = extractStyleSignalsFromPrompt(prompt);

		expect(signals.filter((s) => s === 'minimalist')).toHaveLength(1);
	});

	test('returns empty array when no known cues are present', () => {
		const prompt = 'Create an online shop for stationery products.';
		const signals = extractStyleSignalsFromPrompt(prompt);

		expect(signals).toEqual([]);
	});

	test('extracts expanded style cues for stronger prompt responsiveness', () => {
		const prompt = 'Build an edgy brutalist streetwear store with punchy high-energy visuals and raw industrial blocks.';
		const signals = extractStyleSignalsFromPrompt(prompt);

		expect(signals).toContain('brutalist');
		expect(signals).toContain('streetwear/urban');
		expect(signals).toContain('high-energy');
	});
});
