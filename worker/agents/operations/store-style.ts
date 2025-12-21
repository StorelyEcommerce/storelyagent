import { OpenAI } from 'openai';
import { createLogger } from 'worker/logger';
import { getConfigurationForModel } from '../inferutils/core';
import { generateId } from 'worker/utils/idGenerator';
import { ImageAttachment, ProcessedImageAttachment } from 'worker/types/image-attachment';
import { ImageType, uploadImage } from 'worker/utils/images';
import type { InferenceContext } from '../inferutils/config.types';

const logger = createLogger('StoreStyleGenerator');
const IMAGE_MODEL = 'openai/gpt-image-1';
const DEFAULT_IMAGE_COUNT = 3;

export function buildStoreStyleSelectionMessage(images: ProcessedImageAttachment[]): string {
	const header = 'I generated three style options based on your store name and design direction. Reply with 1, 2, or 3 to pick the one you want me to model the site after.';
	const items = images.map((image, index) => {
		const label = `**Option ${index + 1}**`;
		const url = image.publicUrl;
		return `${label}\n![Style option ${index + 1}](${url})`;
	});
	return [header, '', ...items].join('\n\n');
}

export function parseStoreStyleSelection(message: string, maxOptions: number): number | null {
	const match = message.match(/\b([1-9][0-9]*)\b/);
	if (!match) return null;
	const selection = Number.parseInt(match[1], 10);
	if (!Number.isFinite(selection) || selection < 1 || selection > maxOptions) {
		return null;
	}
	return selection - 1;
}

function buildStylePrompt(storeInfo: string): string {
	return `Create a high-fidelity website homepage design concept for an ecommerce store.
Store info and design direction: ${storeInfo}

Requirements:
- Full-page website layout (hero, navigation, featured products, footer)
- Strong typography and color system
- No brand logos or real-world trademarks
- Avoid readable body text (use abstract shapes or blurred text)
- Make it look like a modern storefront website mockup
- Keep the style consistent and usable for a real website`;
}

function buildImageAttachment(base64Data: string, index: number): ImageAttachment {
	return {
		id: generateId(),
		filename: `style-option-${index + 1}.png`,
		mimeType: 'image/png',
		base64Data,
		size: Math.floor((base64Data.length * 3) / 4),
	};
}

export async function generateStoreStyleImages({
	env,
	inferenceContext,
	storeInfo,
	count = DEFAULT_IMAGE_COUNT,
}: {
	env: Env;
	inferenceContext: InferenceContext;
	storeInfo: string;
	count?: number;
}): Promise<ProcessedImageAttachment[]> {
	const { apiKey, baseURL, defaultHeaders } = await getConfigurationForModel(
		IMAGE_MODEL,
		env,
		inferenceContext.userId,
	);
	const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
	const prompt = buildStylePrompt(storeInfo);

	logger.info('Generating store style images', { count });

	const response = await client.images.generate({
		model: IMAGE_MODEL,
		prompt,
		size: '1024x1024',
		n: count,
		response_format: 'b64_json',
	});

	const data = response.data ?? [];
	if (data.length === 0) {
		throw new Error('No images returned from image generation');
	}

	const attachments = data.map((item, index) => {
		const base64 = item.b64_json;
		if (!base64) {
			throw new Error('Image generation response missing base64 data');
		}
		return buildImageAttachment(base64, index);
	});

	const uploaded = await Promise.all(
		attachments.map((attachment) => uploadImage(env, attachment, ImageType.UPLOADS)),
	);

	return uploaded.slice(0, count);
}
