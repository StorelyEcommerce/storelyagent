import { createLogger } from '../../logger';
import { DesignDNA, DesignDNASchema, TemplateSelection } from '../schemas';
import { createMultiModalUserMessage, createSystemMessage, createUserMessage } from '../inferutils/common';
import { executeInference } from '../inferutils/infer';
import type { InferenceContext } from '../inferutils/config.types';
import { imagesToBase64 } from 'worker/utils/images';
import type { ProcessedImageAttachment } from 'worker/types/image-attachment';
import { extractStyleSignalsFromPrompt } from './styleSignals';

const logger = createLogger('DesignDNA');

const SYSTEM_PROMPT = `You are a world-class ecommerce visual design director.
Generate a concrete, implementation-ready "Design DNA" for a storefront.

Rules:
- User prompt style cues are the primary source of truth.
- If user style cues conflict with inferred template style labels, prioritize the user's cues.
- Lock into a distinct visual lane (not a generic default look).
- Prioritize distinctive but usable design decisions.
- Keep guidance actionable for frontend implementation.
- Avoid vague advice; prefer precise constraints and motifs.
- Do not request external assets or paid services.
- Keep all suggestions compatible with modern responsive storefronts.
- Explicitly describe mobile, tablet, and desktop adaptations for the same design language.
- Avoid generic fallback aesthetics like "rounded cards + soft gradient + neutral sans" unless the user explicitly asked for that.
- Every section must contain concrete directives that would make this storefront look different from a generic starter template.`;

export interface DesignDNAGenerationArgs {
	env: Env;
	inferenceContext: InferenceContext;
	query: string;
	templateSelection?: TemplateSelection;
	images?: ProcessedImageAttachment[];
}

export async function generateDesignDNA({
	env,
	inferenceContext,
	query,
	templateSelection,
	images,
}: DesignDNAGenerationArgs): Promise<DesignDNA> {
	logger.info('Generating design DNA', {
		queryLength: query.length,
		imagesCount: images?.length || 0,
		styleSelection: templateSelection?.styleSelection || null,
	});
	const userStyleSignals = extractStyleSignalsFromPrompt(query);

	const styleHint = templateSelection?.styleSelection
		? `Preferred style direction: ${templateSelection.styleSelection}`
		: 'No explicit style selected.';
	const useCaseHint = templateSelection?.useCase
		? `Use case: ${templateSelection.useCase}`
		: 'Use case unspecified.';

	const userPrompt = `Client request:
"${query}"

User-derived style signals from the prompt text: ${userStyleSignals.length > 0 ? userStyleSignals.join(', ') : 'none detected; infer style from text tone and any images'}

${styleHint}
${useCaseHint}

Produce a detailed design DNA that will steer blueprint generation and all implementation phases.

Quality gates:
- Make the visual direction visibly specific to this client request and niche.
- Include one "signature" visual motif that should repeat across key sections.
- Include responsive behavior guidance so the style stays expressive on mobile, tablet, and desktop.
- Anti-patterns should explicitly call out the generic look to avoid for this request.`;

	const userMessage = images && images.length > 0
		? createMultiModalUserMessage(
			userPrompt,
			await imagesToBase64(env, images),
			'high',
		)
		: createUserMessage(userPrompt);

	const { object } = await executeInference({
		env,
		messages: [createSystemMessage(SYSTEM_PROMPT), userMessage],
		agentActionName: 'blueprint',
		schema: DesignDNASchema,
		context: inferenceContext,
		maxTokens: 4000,
		temperature: 0.95,
		format: 'markdown',
	});

	return object;
}
