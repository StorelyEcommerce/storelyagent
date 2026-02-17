import { createSystemMessage, createUserMessage, createMultiModalUserMessage } from '../inferutils/common';
import type { TemplateInfo } from '../../services/sandbox/sandboxTypes';
import { createLogger } from '../../logger';
import { executeInference } from '../inferutils/infer';
import type { InferenceContext } from '../inferutils/config.types';
import { RateLimitExceededError, SecurityError } from 'shared/types/errors';
import { TemplateSelectionSchema, ProjectTypePredictionSchema } from '../../agents/schemas';
import type { TemplateSelection } from '../../agents/schemas';
import { generateSecureToken } from 'worker/utils/cryptoUtils';
import type { ImageAttachment, ProcessedImageAttachment } from '../../types/image-attachment';
import { imageToBase64 } from 'worker/utils/images';
import { InferError } from '../inferutils/core';
import type { ProjectType } from '../core/types';

const logger = createLogger('TemplateSelector');

interface SelectTemplateArgs {
	env: Env;
	query: string;
	projectType?: ProjectType | 'auto';
	availableTemplates: TemplateInfo[];
	inferenceContext: InferenceContext;
	images?: Array<ImageAttachment | ProcessedImageAttachment>;
}

export type TemplateSelectionResult = TemplateSelection & { projectType: ProjectType };

async function toImageUrls(
	env: Env,
	images?: Array<ImageAttachment | ProcessedImageAttachment>
): Promise<string[]> {
	if (!images || images.length === 0) return [];

	return Promise.all(images.map(async (image) => {
		if ('publicUrl' in image) {
			if (image.base64Data) {
				return `data:${image.mimeType};base64,${image.base64Data}`;
			}
			return imageToBase64(env, image);
		}
		return `data:${image.mimeType};base64,${image.base64Data}`;
	}));
}

async function predictProjectType(
	env: Env,
	query: string,
	inferenceContext: InferenceContext,
	imageUrls: string[]
): Promise<ProjectType> {
	const systemPrompt = `You are an Expert Project Type Classifier at Cloudflare. Analyze the user request and return one project type: app, workflow, presentation, or general.

Rules:
- Default to app when uncertain
- workflow only for backend/API/automation requests
- presentation only for slide/deck requests
- general for docs/spec/notes or from-scratch non-runtime artifacts`;

	const userPrompt = `User Request: "${query}"

Return:
1) projectType
2) reasoning
3) confidence`;

	const userMessage = imageUrls.length > 0
		? createMultiModalUserMessage(userPrompt, imageUrls, 'high')
		: createUserMessage(userPrompt);

	const { object: prediction } = await executeInference({
		env,
		messages: [createSystemMessage(systemPrompt), userMessage],
		agentActionName: 'templateSelection',
		schema: ProjectTypePredictionSchema,
		context: inferenceContext,
		maxTokens: 500,
	});

	logger.info('Predicted project type', {
		projectType: prediction.projectType,
		confidence: prediction.confidence,
		reasoning: prediction.reasoning,
	});

	return prediction.projectType;
}

export async function selectTemplate({
	env,
	query,
	projectType = 'auto',
	availableTemplates,
	inferenceContext,
	images,
}: SelectTemplateArgs): Promise<TemplateSelectionResult> {
	try {
		const validTemplateNames = availableTemplates.map(t => t.name);
		if (validTemplateNames.length === 0) {
			throw new Error('No templates available for selection');
		}

		const templateDescriptions = availableTemplates
			.map(t => `${t.name}: ${t.description?.selection || t.description?.usage || 'No description available'}`)
			.join('\n');

		const imageUrls = await toImageUrls(env, images);
		const resolvedProjectType: ProjectType = projectType === 'auto'
			? await predictProjectType(env, query, inferenceContext, imageUrls)
			: projectType;

		const systemPrompt = `You are an Expert Software Architect selecting the best template for the user request.

Rules:
- Pick only from available template names
- Prefer closest feature/architecture match
- If only one template is available, select it
- Keep reasoning specific and short`;

		const userPrompt = `User Request: "${query}"

Available templates: ${validTemplateNames.join(', ')}
Template details:
${templateDescriptions}

Return:
1) selectedTemplateName (exact match from list)
2) reasoning
3) useCase
4) complexity
5) styleSelection
6) projectName

Entropy seed: ${generateSecureToken(64)}`;

		const userMessage = imageUrls.length > 0
			? createMultiModalUserMessage(userPrompt, imageUrls, 'high')
			: createUserMessage(userPrompt);

		const { object: selection } = await executeInference({
			env,
			messages: [createSystemMessage(systemPrompt), userMessage],
			agentActionName: 'templateSelection',
			schema: TemplateSelectionSchema,
			context: inferenceContext,
			maxTokens: 2000,
			format: 'markdown',
		});

		if (!selection) {
			throw new Error('Template selection returned no result');
		}

		const selectedTemplateName = validTemplateNames.includes(selection.selectedTemplateName ?? '')
			? selection.selectedTemplateName
			: validTemplateNames[0];

		const result: TemplateSelectionResult = {
			...selection,
			selectedTemplateName,
			projectType: resolvedProjectType,
		};

		logger.info('Template selection result', {
			selectedTemplateName: result.selectedTemplateName,
			projectType: result.projectType,
			reasoning: result.reasoning,
		});

		return result;
	} catch (error) {
		logger.error('Error during template selection', error);
		if (error instanceof RateLimitExceededError || error instanceof SecurityError || error instanceof InferError) {
			throw error;
		}
		throw new Error(`Template selection failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
