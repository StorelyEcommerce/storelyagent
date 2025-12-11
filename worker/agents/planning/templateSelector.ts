import { createSystemMessage, createUserMessage, createMultiModalUserMessage } from '../inferutils/common';
import { TemplateListResponse} from '../../services/sandbox/sandboxTypes';
import { createLogger } from '../../logger';
import { executeInference } from '../inferutils/infer';
import { InferenceContext } from '../inferutils/config.types';
import { RateLimitExceededError, SecurityError } from 'shared/types/errors';
import { TemplateSelection, TemplateSelectionSchema } from '../../agents/schemas';
import { generateSecureToken } from 'worker/utils/cryptoUtils';
import type { ImageAttachment } from '../../types/image-attachment';

const logger = createLogger('TemplateSelector');
interface SelectTemplateArgs {
    env: Env;
    query: string;
    availableTemplates: TemplateListResponse['templates'];
    inferenceContext: InferenceContext;
    images?: ImageAttachment[];
}

/**
 * Uses AI to select the most suitable template for a given query.
 */
export async function selectTemplate({ env, query, availableTemplates, inferenceContext, images }: SelectTemplateArgs): Promise<TemplateSelection> {
    if (availableTemplates.length === 0) {
        logger.info("No templates available for selection.");
        return { selectedTemplateName: null, reasoning: "No templates were available to choose from.", useCase: null, complexity: null, styleSelection: null, projectName: '' };
    }

    try {
        logger.info("Asking AI to select a template", { 
            query, 
            queryLength: query.length,
            imagesCount: images?.length || 0,
            availableTemplates: availableTemplates.map(t => t.name),
            templateCount: availableTemplates.length 
        });

        const templateDescriptions = availableTemplates.map((t, index) =>
            `- Template #${index + 1} \n Name - ${t.name} \n Language: ${t.language}, Frameworks: ${t.frameworks?.join(', ') || 'None'}\n ${t.description.selection}`
        ).join('\n\n');

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
- **Custom**: Design that doesn't fit any of the above categories

## RULES:
- ALWAYS select a template (never return null)
- If only one template is available, select it and note it's the base template that can be customized
- If multiple templates are available, use selection criteria to choose the best match
- Ignore misleading template names - analyze actual features
- Focus on functionality over naming conventions
- Provide clear, specific reasoning for selection`

        const userPrompt = `**User Request:** "${query}"

**Available Templates:**
${templateDescriptions}

**Task:** Select the most suitable template and provide:
1. Template name (exact match from list)
2. Clear reasoning for why it fits the user's needs
3. Appropriate style for the project type. Try to come up with unique styles that might look nice and unique. Be creative about your choices. But don't pick brutalist all the time.
4. Descriptive project name

Analyze each template's features, frameworks, and architecture to make the best match.
${images && images.length > 0 ? `\n**Note:** User provided ${images.length} image(s) - consider visual requirements and UI style from the images.` : ''}

ENTROPY SEED: ${generateSecureToken(64)} - for unique results`;

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

        const { object: selection } = await executeInference({
            env,
            messages,
            agentActionName: "templateSelection",
            schema: TemplateSelectionSchema,
            context: inferenceContext,
            maxTokens: 2000,
        });


        logger.info(`AI template selection result: ${selection.selectedTemplateName || 'None'}, Reasoning: ${selection.reasoning}`);
        return selection;

    } catch (error) {
        logger.error("Error during AI template selection:", error);
        if (error instanceof RateLimitExceededError || error instanceof SecurityError) {
            throw error;
        }
        // Fallback to no template selection in case of error
        return { selectedTemplateName: null, reasoning: "An error occurred during the template selection process.", useCase: null, complexity: null, styleSelection: null, projectName: '' };
    }
}