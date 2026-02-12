import { createSystemMessage, createUserMessage, createMultiModalUserMessage } from '../inferutils/common';
import { TemplateInfo } from '../../services/sandbox/sandboxTypes';
import { createLogger } from '../../logger';
import { executeInference } from '../inferutils/infer';
import { InferenceContext } from '../inferutils/config.types';
import { RateLimitExceededError, SecurityError } from 'shared/types/errors';
import { TemplateSelection, TemplateSelectionSchema, ProjectTypePredictionSchema } from '../../agents/schemas';
import { generateSecureToken } from 'worker/utils/cryptoUtils';
import type { ImageAttachment, ProcessedImageAttachment } from '../../types/image-attachment';
import { imageToBase64 } from 'worker/utils/images';
import { InferError } from '../inferutils/core';

const logger = createLogger('TemplateSelector');
interface SelectTemplateArgs {
    env: Env;
    query: string;
    projectType?: ProjectType | 'auto';
    availableTemplates: TemplateInfo[];
    inferenceContext: InferenceContext;
    images?: Array<ImageAttachment | ProcessedImageAttachment>;
}

/**
 * Predicts the project type from the user query
 */
async function predictProjectType(
    env: Env,
    query: string,
    inferenceContext: InferenceContext,
    images?: ImageAttachment[]
): Promise<ProjectType> {
    try {
        logger.info('Predicting project type from query', { queryLength: query.length });

        const systemPrompt = `You are an Expert Project Type Classifier at Cloudflare. Your task is to analyze user requests and determine what type of project they want to build.

## PROJECT TYPES:

**app** - Full-stack web applications
- Interactive websites with frontend and backend
- Dashboards, games, social platforms, e-commerce sites
- Any application requiring user interface and interactivity
- Examples: "Build a todo app", "Create a gaming dashboard", "Make a blog platform"

**workflow** - Backend workflows and APIs
- Server-side logic without UI
- API endpoints, cron jobs, webhooks
- Data processing, automation tasks
- Examples: "Create an API to process payments", "Build a webhook handler", "Automate data sync"

**presentation** - Slides and presentation decks
- Slide-based content for presentations
- Marketing decks, pitch decks, educational slides
- Visual storytelling with slides
- Examples: "Create slides about AI", "Make a product pitch deck", "Build a presentation on climate change"

**general** - From-scratch content or mixed artifacts
- Docs/notes/specs in Markdown/MDX, or a slide deck initialized later
- Start with docs when users ask for write-ups; initialize slides if explicitly requested or clearly appropriate
- No sandbox/runtime unless slides/app are initialized by the builder
- Examples: "Write a spec", "Draft an outline and slides if helpful", "Create teaching materials"

## RULES:
- Default to 'app' when uncertain
- Choose 'workflow' only when explicitly about APIs, automation, or backend-only tasks
- Choose 'presentation' only when explicitly about slides, decks, or presentations
- Choose 'general' for docs/notes/specs or when the user asks to start from scratch without a specific runtime template
- Consider the presence of UI/visual requirements as indicator for 'app'
- High confidence when keywords are explicit, medium/low when inferring`;

        const userPrompt = `**User Request:** "${query}"

**Task:** Determine the project type and provide:
1. Project type (app, workflow, presentation, or general)
2. Reasoning for your classification
3. Confidence level (high, medium, low)

Analyze the request carefully and classify accordingly.`;

        const userMessage = images && images.length > 0
            ? createMultiModalUserMessage(
                userPrompt,
                images.map(img => `data:${img.mimeType};base64,${img.base64Data}`),
                'high'
              )
            : createUserMessage(userPrompt);

        const messages = [
            createSystemMessage(systemPrompt),
            userMessage
        ];

        const { object: prediction } = await executeInference({
            env,
            messages,
            agentActionName: "templateSelection", // Reuse existing agent action
            schema: ProjectTypePredictionSchema,
            context: inferenceContext,
            maxTokens: 500,
        });

        logger.info(`Predicted project type: ${prediction.projectType} (${prediction.confidence} confidence)`, {
            reasoning: prediction.reasoning
        });

        const systemPrompt = `You are an Expert Software Architect at Cloudflare specializing in ecommerce store template selection for rapid development. Your task is to select the most suitable starting ecommerce store template from our custom store template repository based on user requirements for building ecommerce stores and ecommerce-related applications.

**CURRENT TEMPLATE AVAILABILITY:**
Currently, there is one base ecommerce store template available in our repository. More specialized templates will be added in the future. When only one template is available, select it. When multiple templates are available, use the selection criteria below to choose the best match.

## SELECTION EXAMPLES (for when multiple templates are available):

**Example 1 - Fashion Store:**
User: "Build an online fashion store with product categories"
Templates: ["base-store", "store-fashion", "store-electronics"]
Selection: "store-fashion" (if available) or "base-store" (if only base template exists)
complexity: "moderate"
Reasoning: "Fashion store template provides product catalog, category filtering, and shopping cart features optimized for fashion retail. If not available, base-store template can be customized for fashion needs."

**Example 2 - Electronics Ecommerce:**
User: "Create an electronics store with product reviews"
Templates: ["base-store", "store-electronics"]
Selection: "store-electronics" (if available) or "base-store" (if only base template exists)
complexity: "moderate"
Reasoning: "Electronics store template includes product specifications, comparison features, and review systems tailored for tech products. If not available, base-store template can be customized."

**Example 3 - General Ecommerce:**
User: "Build a multi-category online store"
Templates: ["base-store"]
Selection: "base-store"
complexity: "complex"
Reasoning: "Base store template provides flexible product management, multiple categories, and comprehensive ecommerce features for diverse product types."

## SELECTION CRITERIA (when multiple templates are available):
1. **Ecommerce Feature Alignment** - Store templates with similar core ecommerce functionality (product catalog, cart, checkout, etc.)
2. **Product Type Match** - Templates optimized for specific product categories (fashion, electronics, general, etc.)
3. **Tech Stack Match** - Compatible frameworks and dependencies  
4. **Architecture Fit** - Similar ecommerce application structure and patterns
5. **Minimal Modification** - Store template requiring least changes for the desired ecommerce functionality

**When only one template is available:**
- Select the available template
- Note that it's the base template and can be customized for any ecommerce use case

## STYLE GUIDE:
- **Minimalist Design**: Clean, simple interfaces
- **Brutalism**: Bold, raw, industrial aesthetics
- **Retro**: Vintage, nostalgic design elements
- **Illustrative**: Rich graphics and visual storytelling
- **Kid_Playful**: Colorful, fun, child-friendly interfaces
- **Editorial Luxe**: Premium, fashion-forward, refined typography and layout
- **Organic Natural**: Earthy tones, tactile spacing, handcrafted feel
- **Tech Futurism**: High-contrast, neon accents, futuristic UI motifs
- **Bold Experimental**: Asymmetry, unusual grids, daring visual hierarchy
- **Custom**: Design that doesn't fit any of the above categories

## RULES:
- ALWAYS select a template (never return null)
- If only one template is available, select it and note it's the base template that can be customized
- If multiple templates are available, use selection criteria to choose the best match
- Ignore misleading template names - analyze actual features
- **ONLY** Choose from the list of available templates
- Focus on functionality over naming conventions
- For styleSelection, derive style primarily from user-provided text and images (brand adjectives, mood words, aesthetic references)
- If your own inferred style conflicts with explicit user styling cues, follow the user's cues
- For styleSelection, prefer non-default styles when the prompt indicates a strong brand identity or mood
- Provide clear, specific reasoning for selection`

        const userPrompt = `**User Request:** "${query}"

## **Available Templates:**
**ONLY** These template names are available for selection: ${validTemplateNames.join(', ')}

Template detail: ${templateDescriptions}

**Task:** Select the most suitable template and provide:
1. Template name (exact match from list)
2. Clear reasoning for why it fits the user's needs
${actualProjectType === 'app' ? '3. Appropriate style for the project type. Try to come up with unique styles that might look nice and unique. Be creative about your choices. But don\'t pick brutalist all the time.' : ''}

Analyze each template's features, frameworks, and architecture to make the best match.
${images && images.length > 0 ? `\n**Note:** User provided ${images.length} image(s) - consider visual requirements and UI style from the images.` : ''}

ENTROPY SEED: ${generateSecureToken(64)} - for unique results`;

        const imageUrls = images && images.length > 0
            ? await Promise.all(images.map(async (image) => {
                if ('publicUrl' in image) {
                    if (image.base64Data) {
                        return `data:${image.mimeType};base64,${image.base64Data}`;
                    }
                    return await imageToBase64(env, image);
                }
                return `data:${image.mimeType};base64,${image.base64Data}`;
            }))
            : [];

        const userMessage = imageUrls.length > 0
            ? createMultiModalUserMessage(
                userPrompt,
                imageUrls,
                'high'
              )
            : createUserMessage(userPrompt);

        const messages = [
            createSystemMessage(systemPrompt),
            userMessage
        ];

        const { object: selection } = await executeInference({
            env,
            messages,
            agentActionName: "templateSelection",
            schema: TemplateSelectionSchema,
            context: inferenceContext,
            maxTokens: 2000,
            format: 'markdown',
        });

        if (!selection) {
            logger.error('Template selection returned no result after all retries');
            throw new Error('Failed to select template: inference returned null');
        }

        logger.info(`AI template selection result: ${selection.selectedTemplateName || 'None'}, Reasoning: ${selection.reasoning}`);
        
        // Ensure projectType is set correctly
        return {
            ...selection,
            projectType: actualProjectType
        };

    } catch (error) {
        logger.error("Error during AI template selection:", error);
        // Propagate meaningful errors instead of swallowing them
        if (error instanceof RateLimitExceededError || error instanceof SecurityError || error instanceof InferError) {
            throw error;
        }
        // For unexpected errors, wrap with more context
        throw new Error(`Template selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
