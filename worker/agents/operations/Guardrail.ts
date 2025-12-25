import { GuardRailsOutputType, GuardRailsOutputSchema } from '../schemas';
import { executeInference } from '../inferutils/infer';
import { AgentOperation, OperationOptions } from './common';
import { createSystemMessage, createUserMessage } from '../inferutils/common';

export interface GuardRailsInput {
    userInput: string;
}

const SYSTEM_PROMPT = `You are a strict guardrail for an AI coding agent specializing in building E-commerce stores.

Your JOB is to classify the user's request into one of two categories:
1. **ALLOWED**: The user is directly asking to BUILD, CREATE, MODIFY, or DEBUG an e-commerce store or feature.
   - Examples: "Create a shoe store", "Add a cart button", "Fix the checkout bug", "Change the color scheme".
2. **BLOCKED**: The user is asking general questions, seeking advice, discussing business strategy, or asking about non-ecommerce topics.
   - Examples: "How do I start a business?", "What is the best platform?", "Write a poem", "What is the capital of France?", "How does this code work?".

**RULES**:
- You must be VERY STRICT. If the user is just chatting or asking for information, BLOCK IT.
- Only allow requests that result in code generation or direct project modification.
- If BLOCKED, provide a polite but firm \`refusalReason\` explaining that you only build and modify e-commerce stores.
`;

export class GuardRailsOperation extends AgentOperation<GuardRailsInput, GuardRailsOutputType> {
    async execute(
        inputs: GuardRailsInput,
        options: OperationOptions
    ): Promise<GuardRailsOutputType> {
        const { userInput } = inputs;
        const { env, logger } = options;

        try {
            const result = await executeInference({
                env: env,
                messages: [
                    createSystemMessage(SYSTEM_PROMPT),
                    createUserMessage(userInput)
                ],
                schema: GuardRailsOutputSchema,
                agentActionName: "guardrailCheck",
                context: options.inferenceContext,
                // Fast model preference if available, otherwise default
            });

            const guardResult = result.object as GuardRailsOutputType;

            if (!guardResult) {
                // Fallback safe
                return { isAllowed: true };
            }

            return guardResult;
        } catch (error) {
            logger.error("Error during guardrail check:", error);
            // Default to allowed in case of error to avoid blocking valid requests due to system failure, 
            // or valid depending on safety policy. Here we act fail-open for UX.
            return { isAllowed: true };
        }
    }
}
