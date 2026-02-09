import { describe, expect, test } from 'vitest';
import { generalSystemPromptBuilder } from './prompts';
import type { DesignDNA } from './schemas';

describe('generalSystemPromptBuilder', () => {
	test('appends DESIGN_DNA context when provided', () => {
		const prompt = 'SYSTEM TEMPLATE {{query}}';
		const designDNA: DesignDNA = {
			visualDirection: 'Editorial modern luxury',
			colorStrategy: ['High contrast neutrals', 'Single warm accent'],
			typographySystem: ['Display serif for hero', 'Neutral sans for body'],
			layoutPrinciples: ['Asymmetric hero', 'Generous whitespace'],
			componentMotifs: ['Soft borders', 'Card layering'],
			motionGuidelines: ['Subtle fade and slide in'],
			antiPatterns: ['No generic marketplace look'],
			moodKeywords: ['refined', 'premium', 'calm', 'editorial', 'modern'],
		};

		const formatted = generalSystemPromptBuilder(prompt, {
			query: 'build a premium fashion storefront',
			designDNA,
			templateDetails: {
				name: 'base-store',
				frameworks: ['liquid'],
				description: {
					usage: 'Use the base store template and customize frontend theme files.',
					selection: 'Base ecommerce template',
				},
				dontTouchFiles: [],
				redactedFiles: [],
			} as any,
			dependencies: {},
		});

		expect(formatted).toContain('<DESIGN_DNA>');
		expect(formatted).toContain('visualDirection');
		expect(formatted).toContain('Editorial modern luxury');
		expect(formatted).toContain('</DESIGN_DNA>');
	});
});
