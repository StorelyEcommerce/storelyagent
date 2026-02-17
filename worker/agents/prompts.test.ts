import { describe, expect, test } from 'vitest';
import { generalSystemPromptBuilder, getUsecaseSpecificInstructions } from './prompts';
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

	test('includes selected style guidance for ecommerce use case', () => {
		const instructions = getUsecaseSpecificInstructions({
			selectedTemplateName: 'base-store',
			reasoning: 'Best match',
			useCase: 'E-Commerce',
			complexity: 'simple',
			styleSelection: 'Brutalism',
			projectName: 'Street Forge',
		});

		expect(instructions).toContain('Use the following artistic style:');
		expect(instructions).toContain('Style Name: Brutalism');
	});
});
