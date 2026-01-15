import { GuardrailOutputType, GuardrailSchema } from '../schemas';
import { createSystemMessage, createUserMessage } from '../inferutils/common';
import { executeInference } from '../inferutils/infer';
import { InferenceContext } from '../inferutils/config.types';
import { createLogger } from '../../logger';

export interface GuardrailInput {
    userInput: string;
}

const SYSTEM_PROMPT = `You are a guardrail system for Storely, an AI-powered e-commerce store building platform.

Your job is to evaluate user requests and determine if they should be allowed to proceed.

## ALLOWED REQUESTS (isAllowed: true):
1. **Direct e-commerce store building requests** - Creating, building, or generating an online store, shop, or e-commerce website
   - Examples: "Create a store for selling shoes", "Build me an online boutique", "Generate an e-commerce site for my bakery"
   - Reason: ecommerce_build

2. **E-commerce store modification requests** - Modifying, updating, or improving an existing store that was built on this platform
   - Examples: "Add a cart feature", "Change the color scheme", "Add product filtering", "Fix the checkout button"
   - Reason: ecommerce_modify

## REJECTED REQUESTS (isAllowed: false):

1. **Off-topic requests** - Requests that have nothing to do with e-commerce or building stores
   - Examples: "Write me a poem", "Help me with my homework", "What's the weather today", "Create a calculator app", "Build a game"
   - Reason: rejected_off_topic

2. **General e-commerce questions** - Questions ABOUT e-commerce platforms, strategies, or concepts WITHOUT actually building/modifying a store
   - Examples: "How does Shopify work?", "What's the best way to market an online store?", "Compare WooCommerce vs Shopify", "How do I improve my store's SEO?", "What products sell best online?"
   - Reason: rejected_general_question

3. **Harmful or policy-violating requests** - Requests that could be harmful, illegal, or violate policies
   - Examples: Requests for illegal content, scam sites, phishing, malware, or anything harmful
   - Reason: rejected_harmful

## IMPORTANT DISTINCTIONS:
- "Create a store that sells X" = ALLOWED (building a store)
- "How do I create a store that sells X?" = REJECTED (asking a question about creating)
- "Add a feature to show related products" = ALLOWED (modifying a store)
- "How should I organize my product categories?" = REJECTED (asking for advice)
- "Build an online shop for my pottery business" = ALLOWED (building a store)
- "What platform is best for selling pottery online?" = REJECTED (asking for comparison)

Be strict about this distinction: we only want to process requests that are **actively building or modifying** a store, not answering questions about e-commerce.`;

const USER_PROMPT = `Evaluate the following user request and determine if it should be allowed:

User Request: "{{userInput}}"

Analyze this request and return your decision.`;

/**
 * Check if a user request passes the guardrail
 * Returns the guardrail result with isAllowed, reason, and explanation
 */
export async function checkGuardrail(
    userInput: string,
    env: Env,
    inferenceContext: InferenceContext
): Promise<GuardrailOutputType> {
    const logger = createLogger('Guardrail');

    const userPrompt = USER_PROMPT.replace('{{userInput}}', userInput);

    try {
        const result = await executeInference({
            env,
            messages: [
                createSystemMessage(SYSTEM_PROMPT),
                createUserMessage(userPrompt)
            ],
            agentActionName: 'guardrailCheck',
            schema: GuardrailSchema,
            context: inferenceContext,
        });

        const guardrailResult = result.object as GuardrailOutputType;
        logger.info('Guardrail check result', {
            isAllowed: guardrailResult.isAllowed,
            reason: guardrailResult.reason,
            inputPreview: userInput.substring(0, 100)
        });

        return guardrailResult;
    } catch (error) {
        logger.error('Error in guardrail check', { error });
        // Default to allowing if guardrail fails (fail-open for better UX)
        // This prevents the guardrail from blocking legitimate requests due to errors
        return {
            isAllowed: true,
            reason: 'ecommerce_build',
            explanation: 'Guardrail check failed, defaulting to allow'
        };
    }
}

/**
 * Get a user-friendly rejection message based on the guardrail result
 */
export function getGuardrailRejectionMessage(result: GuardrailOutputType): string {
    switch (result.reason) {
        case 'rejected_off_topic':
            return `I'm sorry, but I can only help you build and modify e-commerce stores. Your request appears to be unrelated to e-commerce store development.

If you'd like to create an online store or modify an existing one, I'd be happy to help! Just describe what kind of store you want to build or what changes you'd like to make.`;

        case 'rejected_general_question':
            return `I'm designed specifically to build and modify e-commerce stores, not to answer general questions about e-commerce.

Instead of asking questions, try telling me what you want to build! For example:
- "Create an online store for selling handmade jewelry"
- "Build a fashion boutique with a minimalist design"
- "Add a product filtering feature to my store"

What would you like me to build for you?`;

        case 'rejected_harmful':
            return `I'm sorry, but I can't process this request as it appears to violate our content policies.

If you believe this is a mistake, please try rephrasing your request. I'm here to help you build legitimate e-commerce stores.`;

        default:
            return `I'm sorry, but I can only help with building and modifying e-commerce stores. Please describe what kind of store you'd like to create or modify.`;
    }
}
