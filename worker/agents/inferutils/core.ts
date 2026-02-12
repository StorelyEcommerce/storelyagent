import { OpenAI } from 'openai';
import { Stream } from 'openai/streaming';
import { z } from 'zod';
import {
    type SchemaFormat,
    type FormatterOptions,
    generateTemplateForSchema,
    parseContentForSchema,
} from './schemaFormatters';
import { zodResponseFormat } from 'openai/helpers/zod.mjs';
import {
    ChatCompletionMessageFunctionToolCall,
    type ReasoningEffort,
    type ChatCompletionChunk,
} from 'openai/resources.mjs';
import { CompletionSignal, Message, MessageContent, MessageRole } from './common';
import { ToolCallResult, ToolDefinition, toOpenAITool } from '../tools/types';
import { AgentActionKey, AI_MODEL_CONFIG, AIModelConfig, AIModels, InferenceMetadata, type InferenceRuntimeOverrides } from './config.types';
import { RateLimitService } from '../../services/rate-limit/rateLimits';
import { getUserConfigurableSettings } from '../../config';
import { SecurityError, RateLimitExceededError } from 'shared/types/errors';
import { RateLimitType } from 'worker/services/rate-limit/config';
import { getMaxToolCallingDepth, MAX_LLM_MESSAGES } from '../constants';
import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from './zodToJsonSchema';

function optimizeInputs(messages: Message[]): Message[] {
    return messages.map((message) => ({
        ...message,
        content: optimizeMessageContent(message.content),
    }));
}

// Streaming tool-call accumulation helpers 
type ToolCallsArray = NonNullable<NonNullable<ChatCompletionChunk['choices'][number]['delta']>['tool_calls']>;
type ToolCallDelta = ToolCallsArray[number];
type ToolAccumulatorEntry = ChatCompletionMessageFunctionToolCall & { index?: number; __order: number };

function synthIdForIndex(i: number): string {
    return `tool_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`;
}

function accumulateToolCallDelta(
    byIndex: Map<number, ToolAccumulatorEntry>,
    byId: Map<string, ToolAccumulatorEntry>,
    deltaToolCall: ToolCallDelta,
    orderCounterRef: { value: number }
): void {
    const idx = deltaToolCall.index;
    const idFromDelta = deltaToolCall.id;

    let entry: ToolAccumulatorEntry | undefined;

    // Look up existing entry by id or index
    if (idFromDelta && byId.has(idFromDelta)) {
        entry = byId.get(idFromDelta)!;
        console.log(`[TOOL_CALL_DEBUG] Found existing entry by id: ${idFromDelta}`);
    } else if (idx !== undefined && byIndex.has(idx)) {
        entry = byIndex.get(idx)!;
        console.log(`[TOOL_CALL_DEBUG] Found existing entry by index: ${idx}`);
    } else {
        console.log(`[TOOL_CALL_DEBUG] Creating new entry - id: ${idFromDelta}, index: ${idx}`);
        // Create new entry
        const provisionalId = idFromDelta || synthIdForIndex(idx ?? byId.size);
        entry = {
            id: provisionalId,
            type: 'function',
            function: {
                name: '',
                arguments: '',
            },
            __order: orderCounterRef.value++,
            ...(idx !== undefined ? { index: idx } : {}),
        };
        if (idx !== undefined) byIndex.set(idx, entry);
        byId.set(provisionalId, entry);
    }

    // Update id if provided and different
    if (idFromDelta && entry.id !== idFromDelta) {
        byId.delete(entry.id);
        entry.id = idFromDelta;
        byId.set(entry.id, entry);
    }

    // Register index if provided and not yet registered
    if (idx !== undefined && entry.index === undefined) {
        entry.index = idx;
        byIndex.set(idx, entry);
    }

    // Update function name - replace if provided
    if (deltaToolCall.function?.name) {
        entry.function.name = deltaToolCall.function.name;
    }

    // Append arguments - accumulate string chunks
    if (deltaToolCall.function?.arguments !== undefined) {
        const before = entry.function.arguments;
        const chunk = deltaToolCall.function.arguments;

        // Check if we already have complete JSON and this is extra data. Question: Do we want this?
        let isComplete = false;
        if (before.length > 0) {
            try {
                JSON.parse(before);
                isComplete = true;
                console.warn(`[TOOL_CALL_WARNING] Already have complete JSON, ignoring additional chunk for ${entry.function.name}:`, {
                    existing_json: before,
                    ignored_chunk: chunk
                });
            } catch {
                // Not complete yet, continue accumulating
            }
        }

        if (!isComplete) {
            entry.function.arguments += chunk;

            // Debug logging for tool call argument accumulation
            console.log(`[TOOL_CALL_DEBUG] Accumulating arguments for ${entry.function.name || 'unknown'}:`, {
                id: entry.id,
                index: entry.index,
                before_length: before.length,
                chunk_length: chunk.length,
                chunk_content: chunk,
                after_length: entry.function.arguments.length,
                after_content: entry.function.arguments
            });
        }
    }
}

function assembleToolCalls(
    byIndex: Map<number, ToolAccumulatorEntry>,
    byId: Map<string, ToolAccumulatorEntry>
): ChatCompletionMessageFunctionToolCall[] {
    if (byIndex.size > 0) {
        return Array.from(byIndex.values())
            .sort((a, b) => (a.index! - b.index!))
            .map((e) => ({ id: e.id, type: 'function' as const, function: { name: e.function.name, arguments: e.function.arguments } }));
    }
    return Array.from(byId.values())
        .sort((a, b) => a.__order - b.__order)
        .map((e) => ({ id: e.id, type: 'function' as const, function: { name: e.function.name, arguments: e.function.arguments } }));
}

function optimizeMessageContent(content: MessageContent): MessageContent {
    if (!content) return content;
    // If content is an array (TextContent | ImageContent), only optimize text content
    if (Array.isArray(content)) {
        return content.map((item) =>
            item.type === 'text'
                ? { ...item, text: optimizeTextContent(item.text) }
                : item,
        );
    }

    // If content is a string, optimize it directly
    return optimizeTextContent(content);
}

function optimizeTextContent(content: string): string {
    // CONSERVATIVE OPTIMIZATION - Only safe changes that preserve readability

    // 1. Remove trailing whitespace from lines (always safe)
    content = content.replace(/[ \t]+$/gm, '');

    // 2. Reduce excessive empty lines (more than 3 consecutive) to 2 max
    // This preserves intentional spacing while removing truly excessive gaps
    content = content.replace(/\n\s*\n\s*\n\s*\n+/g, '\n\n\n');

    // // Convert 4-space indentation to 2-space for non-Python/YAML content
    // content = content.replace(/^( {4})+/gm, (match) =>
    // 	'  '.repeat(match.length / 4),
    // );

    // // Convert 8-space indentation to 2-space
    // content = content.replace(/^( {8})+/gm, (match) =>
    // 	'  '.repeat(match.length / 8),
    // );
    // 4. Remove leading/trailing whitespace from the entire content
    // (but preserve internal structure)
    content = content.trim();

    return content;
}

/**
 * Convert messages format to responses API input format
 * Responses API uses input array with role and content array structure
 */
function convertMessagesToResponsesInput(messages: Message[]): Array<{
    role: 'user' | 'assistant';
    content: Array<{ type: 'text'; text: string }>;
}> {
    return messages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .map(msg => {
            let textContent = '';

            if (typeof msg.content === 'string') {
                textContent = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Extract text from multi-modal content
                const textParts = msg.content
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
                textContent = textParts;
            }

            return {
                role: msg.role as 'user' | 'assistant',
                content: [{ type: 'text' as const, text: textContent }],
            };
        });
}

export async function buildGatewayUrl(env: Env, providerOverride?: AIGatewayProviders): Promise<string> {
    // If CLOUDFLARE_AI_GATEWAY_URL is set and is a valid URL, use it directly
    if (env.CLOUDFLARE_AI_GATEWAY_URL &&
        env.CLOUDFLARE_AI_GATEWAY_URL !== 'none' &&
        env.CLOUDFLARE_AI_GATEWAY_URL.trim() !== '') {

        try {
            const url = new URL(env.CLOUDFLARE_AI_GATEWAY_URL);
            // Validate it's actually an HTTP/HTTPS URL
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                // Add 'providerOverride' as a segment to the URL
                const cleanPathname = url.pathname.replace(/\/$/, ''); // Remove trailing slash
                url.pathname = buildGatewayPathname(cleanPathname, providerOverride);
                return url.toString();
            }
        } catch (error) {
            // Invalid URL, fall through to use bindings
            console.warn(`Invalid CLOUDFLARE_AI_GATEWAY_URL provided: ${env.CLOUDFLARE_AI_GATEWAY_URL}. Falling back to AI bindings.`);
        }
    }

    // Build the url via bindings
    const gateway = env.AI.gateway(env.CLOUDFLARE_AI_GATEWAY);
    const baseUrl = providerOverride ? await gateway.getUrl(providerOverride) : `${await gateway.getUrl()}compat`;
    return baseUrl;
}

function isValidApiKey(apiKey: string): boolean {
    if (!apiKey || apiKey.trim() === '') {
        return false;
    }
    // Check if value is not 'default' or 'none' and is more than 10 characters long
    if (apiKey.trim().toLowerCase() === 'default' || apiKey.trim().toLowerCase() === 'none' || apiKey.trim().length < 10) {
        return false;
    }
    return true;
}

async function getApiKey(
	provider: string,
	env: Env,
	_userId: string,
	runtimeOverrides?: InferenceRuntimeOverrides,
): Promise<string> {
    console.log("Getting API key for provider: ", provider);

    const runtimeKey = runtimeOverrides?.userApiKeys?.[provider];
    if (runtimeKey && isValidApiKey(runtimeKey)) {
        return runtimeKey;
    }
    // Fallback to environment variables
    const providerKeyString = provider.toUpperCase().replaceAll('-', '_');
    const envKey = `${providerKeyString}_API_KEY` as keyof Env;
    let apiKey: string = env[envKey] as string;

    // Check if apiKey is empty or undefined and is valid
    if (!isValidApiKey(apiKey)) {
        // only use platform token if NOT using a custom gateway URL
        // User's gateway = user's credentials only
        if (runtimeOverrides?.aiGatewayOverride?.baseUrl) {
            // User provided custom gateway
            apiKey = runtimeOverrides.aiGatewayOverride.token ?? '';
        } else {
            apiKey = runtimeOverrides?.aiGatewayOverride?.token ?? env.CLOUDFLARE_AI_GATEWAY_TOKEN;
        }
    }
    return apiKey;
}

export async function getConfigurationForModel(
    model: AIModels | string,
    env: Env,
    userId: string,
    runtimeOverrides?: InferenceRuntimeOverrides,
): Promise<{
    baseURL: string,
    apiKey: string,
    defaultHeaders?: Record<string, string>,
}> {
    let providerForcedOverride: AIGatewayProviders | undefined;
    if (modelConfig.directOverride) {
        switch(modelConfig.provider) {
            case 'openrouter':
                return {
                    baseURL: 'https://openrouter.ai/api/v1',
                    apiKey: env.OPENROUTER_API_KEY,
                };
            case 'google-ai-studio':
                return {
                    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
                    apiKey: env.GOOGLE_AI_STUDIO_API_KEY,
                };
            case 'anthropic':
                return {
                    baseURL: 'https://api.anthropic.com/v1/',
                    apiKey: env.ANTHROPIC_API_KEY,
                };
            default:
                providerForcedOverride = modelConfig.provider as AIGatewayProviders;
                break;
        }
    }

    const gatewayOverride = runtimeOverrides?.aiGatewayOverride;
    const isUsingCustomGateway = !!gatewayOverride?.baseUrl;
    const baseURL = await buildGatewayUrl(env, providerForcedOverride, gatewayOverride);

    const gatewayToken = isUsingCustomGateway
        ? gatewayOverride?.token
        : (gatewayOverride?.token ?? env.CLOUDFLARE_AI_GATEWAY_TOKEN);  // Platform gateway

    // Try to find API key of type <PROVIDER>_API_KEY else default to gateway token
    const apiKey = await getApiKey(modelConfig.provider, env, userId, runtimeOverrides);

    // AI Gateway wholesaling: when using BYOK provider key + platform gateway token
    const defaultHeaders = gatewayToken && apiKey !== gatewayToken ? {
        'cf-aig-authorization': `Bearer ${gatewayToken}`,
    } : undefined;
    return {
        baseURL,
        apiKey,
        defaultHeaders
    };
}

type InferArgsBase = {
    env: Env;
    metadata: InferenceMetadata;
    actionKey: AgentActionKey | 'testModelConfig';
    messages: Message[];
    maxTokens?: number;
    modelName: AIModels | string;
    reasoning_effort?: ReasoningEffort;
    temperature?: number;
    frequency_penalty?: number;
    stream?: {
        chunk_size: number;
        onChunk: (chunk: string) => void;
    };
    tools?: ToolDefinition<any, any>[];
    providerOverride?: 'cloudflare' | 'direct';
    runtimeOverrides?: InferenceRuntimeOverrides;
    abortSignal?: AbortSignal;
    onAssistantMessage?: (message: Message) => Promise<void>;
    completionConfig?: CompletionConfig;
};

type InferArgsStructured = InferArgsBase & {
    schema: z.AnyZodObject;
    schemaName: string;
};

type InferWithCustomFormatArgs = InferArgsStructured & {
    format?: SchemaFormat;
    formatOptions?: FormatterOptions;
};

export interface ToolCallContext {
    messages: Message[];
    depth: number;
    completionSignal?: CompletionSignal;
    warningInjected?: boolean;
}

/**
 * Configuration for completion signal detection and auto-warning injection.
 */
export interface CompletionConfig {
    detector?: CompletionDetector;
    operationalMode?: 'initial' | 'followup';
    allowWarningInjection?: boolean;
}

export function serializeCallChain(context: ToolCallContext, finalResponse: string): string {
    // Build a transcript of the tool call messages, and append the final response
    let transcript = '**Request terminated by user, partial response transcript (last 5 messages):**\n\n<call_chain_transcript>';
    for (const message of context.messages.slice(-5)) {
        let content = message.content;

        // Truncate tool messages to 100 chars
        if (message.role === 'tool' || message.role === 'function') {
            content = (content || '').slice(0, 100);
        }

        transcript += `<message role="${message.role}">${content}</message>`;
    }
    transcript += `<final_response>${finalResponse || '**cancelled**'}</final_response>`;
    transcript += '</call_chain_transcript>';
    return transcript;
}

export class InferError extends Error {
    constructor(
        message: string,
        public response: string,
        public toolCallContext?: ToolCallContext
    ) {
        super(message);
        this.name = 'InferError';
    }

    partialResponseTranscript(): string {
        if (!this.toolCallContext) {
            return this.response;
        }
        return serializeCallChain(this.toolCallContext, this.response);
    }

    partialResponse(): InferResponseString {
        return {
            string: this.response,
            toolCallContext: this.toolCallContext
        };
    }
}

export class AbortError extends InferError {
    constructor(response: string, toolCallContext?: ToolCallContext) {
        super(response, response, toolCallContext);
        this.name = 'AbortError';
    }
}

const claude_thinking_budget_tokens = {
    medium: 8000,
    high: 16000,
    low: 4000,
    minimal: 1000,
};

export type InferResponseObject<OutputSchema extends z.AnyZodObject> = {
    object: z.infer<OutputSchema>;
    toolCallContext?: ToolCallContext;
};

export type InferResponseString = {
    string: string;
    toolCallContext?: ToolCallContext;
};

/**
 * Execute all tool calls from OpenAI response
 */
async function executeToolCalls(openAiToolCalls: ChatCompletionMessageFunctionToolCall[], originalDefinitions: ToolDefinition[]): Promise<ToolCallResult[]> {
    const toolDefinitions = new Map(originalDefinitions.map(td => [td.function.name, td]));
    return Promise.all(
        openAiToolCalls.map(async (tc) => {
            try {
                const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                const td = toolDefinitions.get(tc.function.name);
                if (!td) {
                    throw new Error(`Tool ${tc.function.name} not found`);
                }
                const result = await executeToolWithDefinition(td, args);
                console.log(`Tool execution result for ${tc.function.name}:`, result);
                return {
                    id: tc.id,
                    name: tc.function.name,
                    arguments: args,
                    result
                };
            } catch (error) {
                console.error(`Tool execution failed for ${tc.function.name}:`, error);
                return {
                    id: tc.id,
                    name: tc.function.name,
                    arguments: {},
                    result: { error: `Failed to execute ${tc.function.name}: ${error instanceof Error ? error.message : 'Unknown error'}` }
                };
            }
        })
    );
}

/**
 * Check if a model is a Claude model that should use native Anthropic API
 */
function isClaudeModel(modelName: string): boolean {
    return modelName.includes('claude') || modelName.includes('anthropic');
}

/**
 * Extract the Claude model name from provider/model format
 */
function extractClaudeModelName(modelName: string): string {
    // Handle formats like 'anthropic/claude-sonnet-4-5' or '[claude]claude-sonnet-4-5'
    let name = modelName.replace(/\[.*?\]/, '');
    if (name.includes('/')) {
        name = name.split('/')[1];
    }
    return name;
}

/**
 * Convert OpenAI-style tool definitions to Anthropic's BetaTool format
 * Adds strict: true for guaranteed schema compliance
 */
function convertToolsToAnthropicFormat(tools: ToolDefinition<any, any>[]): Anthropic.Beta.BetaTool[] {
    return tools.map((tool): Anthropic.Beta.BetaTool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: {
            type: 'object',
            properties: (tool.function.parameters as any)?.properties || {},
            required: (tool.function.parameters as any)?.required || [],
        },
        strict: true, // Enable guaranteed schema compliance for tool inputs
    }));
}

/**
 * Execute tool calls from Anthropic's tool_use blocks
 */
async function executeAnthropicToolCalls(
    toolUseBlocks: Anthropic.Beta.BetaToolUseBlock[],
    originalDefinitions: ToolDefinition<any, any>[]
): Promise<{
    id: string;
    name: string;
    input: unknown;
    result: unknown;
    isError: boolean;
}[]> {
    const toolDefinitions = new Map(originalDefinitions.map(td => [td.function.name, td]));

    return Promise.all(
        toolUseBlocks.map(async (toolUse) => {
            try {
                const td = toolDefinitions.get(toolUse.name);
                if (!td) {
                    throw new Error(`Tool ${toolUse.name} not found`);
                }

                // Anthropic already parses the input, no need to JSON.parse
                const args = toolUse.input as Record<string, unknown>;

                // Call onStart callback if defined
                if (td.onStart) {
                    td.onStart(args);
                }

                const result = await td.implementation(args);

                // Call onComplete callback if defined
                if (td.onComplete) {
                    td.onComplete(args, result);
                }

                console.log(`[AnthropicToolCall] Executed ${toolUse.name}:`, result);

                return {
                    id: toolUse.id,
                    name: toolUse.name,
                    input: args,
                    result,
                    isError: false,
                };
            } catch (error) {
                console.error(`[AnthropicToolCall] Failed to execute ${toolUse.name}:`, error);
                return {
                    id: toolUse.id,
                    name: toolUse.name,
                    input: toolUse.input,
                    result: { error: `Failed to execute ${toolUse.name}: ${error instanceof Error ? error.message : 'Unknown error'}` },
                    isError: true,
                };
            }
        })
    );
}

/**
 * Format tool results for the next Anthropic API call
 * Tool results go in a user message with tool_result content blocks
 */
function formatToolResultsForAnthropic(
    toolResults: { id: string; result: unknown; isError: boolean }[]
): Anthropic.Beta.BetaToolResultBlockParam[] {
    return toolResults.map((tr): Anthropic.Beta.BetaToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: tr.id,
        content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
        is_error: tr.isError,
    }));
}

/**
 * Convert internal messages to Anthropic message format
 */
function convertToAnthropicMessages(messages: Message[]): {
    system: string | undefined;
    messages: Anthropic.MessageParam[];
} {
    let systemPrompt: string | undefined;
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            // Anthropic handles system messages separately
            if (typeof msg.content === 'string') {
                systemPrompt = systemPrompt ? `${systemPrompt}\n\n${msg.content}` : msg.content;
            } else if (Array.isArray(msg.content)) {
                const textContent = msg.content
                    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                systemPrompt = systemPrompt ? `${systemPrompt}\n\n${textContent}` : textContent;
            }
            continue;
        }

        // Convert content to Anthropic format
        let content: Anthropic.ContentBlockParam[] | string;

        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            content = msg.content.map((item): Anthropic.ContentBlockParam => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    // Convert OpenAI image format to Anthropic format
                    const imageUrl = item.image_url.url;
                    if (imageUrl.startsWith('data:')) {
                        // Handle base64 data URLs
                        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                        if (matches) {
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: matches[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                                    data: matches[2],
                                },
                            };
                        }
                    }
                    // URL-based images
                    return {
                        type: 'image',
                        source: {
                            type: 'url',
                            url: imageUrl,
                        },
                    };
                }
                // Default to text block
                return { type: 'text', text: JSON.stringify(item) };
            });
        } else {
            content = '';
        }

        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        anthropicMessages.push({ role, content });
    }

    // Anthropic requires alternating user/assistant messages
    // Merge consecutive messages of the same role
    const mergedMessages: Anthropic.MessageParam[] = [];
    for (const msg of anthropicMessages) {
        if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== msg.role) {
            mergedMessages.push(msg);
        } else {
            // Merge with previous message of same role
            const prev = mergedMessages[mergedMessages.length - 1];
            if (typeof prev.content === 'string' && typeof msg.content === 'string') {
                prev.content = `${prev.content}\n\n${msg.content}`;
            } else {
                // Convert to array and merge
                const prevContent = typeof prev.content === 'string'
                    ? [{ type: 'text' as const, text: prev.content }]
                    : prev.content;
                const msgContent = typeof msg.content === 'string'
                    ? [{ type: 'text' as const, text: msg.content }]
                    : msg.content;
                prev.content = [...prevContent, ...msgContent] as Anthropic.ContentBlockParam[];
            }
        }
    }

    return { system: systemPrompt, messages: mergedMessages };
}

/**
 * Perform inference using Anthropic's native API with structured outputs and tool calling
 * Uses the beta structured-outputs feature for guaranteed schema compliance
 * 
 * See: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
async function inferWithAnthropicNative<OutputSchema extends z.AnyZodObject>({
    env,
    metadata,
    messages,
    schema,
    schemaName,
    modelName,
    maxTokens,
    temperature,
    stream,
    tools,
    actionKey,
    toolCallContext,
}: {
    env: Env;
    metadata: InferenceMetadata;
    messages: Message[];
    schema?: OutputSchema;
    schemaName?: string;
    modelName: string;
    maxTokens?: number;
    temperature?: number;
    stream?: {
        chunk_size: number;
        onChunk: (chunk: string) => void;
    };
    tools?: ToolDefinition<any, any>[];
    actionKey: AgentActionKey | 'testModelConfig';
    toolCallContext?: ToolCallContext;
}): Promise<InferResponseObject<OutputSchema> | InferResponseString> {
    // Mark metadata as used (reserved for future logging/telemetry)
    void metadata;

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required for Claude native API');
    }

    const client = new Anthropic({ apiKey });
    const claudeModelName = extractClaudeModelName(modelName);

    // Convert messages to Anthropic format
    const { system, messages: anthropicMessages } = convertToAnthropicMessages(messages);

    // Convert tools to Anthropic format with strict: true
    const anthropicTools = tools ? convertToolsToAnthropicFormat(tools) : undefined;

    // Build JSON Schema from Zod schema for structured output
    const outputFormat = schema ? {
        type: 'json_schema' as const,
        schema: zodToJsonSchema(schema),
    } : undefined;

    const hasTools = anthropicTools && anthropicTools.length > 0;

    console.log(`[ClaudeNative] Using native Anthropic API`);
    console.log(`[ClaudeNative] Model: ${claudeModelName}, Schema: ${schemaName || 'none'}, Tools: ${hasTools ? anthropicTools.length : 0}`);

    // Track conversation for tool calling loop
    // Use BetaMessageParam type for compatibility with beta API features
    let currentMessages: Anthropic.Beta.BetaMessageParam[] = anthropicMessages.map(msg => ({
        role: msg.role,
        content: msg.content as Anthropic.Beta.BetaContentBlockParam[] | string,
    }));
    const currentDepth = toolCallContext?.depth ?? 0;
    const maxDepth = getMaxToolCallingDepth(actionKey);

    try {
        // Tool calling loop - continue until we get a final response or hit max depth
        let iterationCount = 0;
        const maxIterations = maxDepth - currentDepth;

        while (iterationCount < maxIterations) {
            iterationCount++;

            // Build the API request
            const requestParams: Anthropic.Beta.MessageCreateParams = {
                model: claudeModelName,
                max_tokens: maxTokens || 16000,
                temperature: temperature,
                messages: currentMessages,
                betas: ['structured-outputs-2025-11-13'],
            };

            // Add system prompt if present
            if (system) {
                requestParams.system = system;
            }

            // Add tools if present
            if (hasTools) {
                requestParams.tools = anthropicTools;
            }

            // Add output format for structured output (only if no tools or on final response)
            // Note: When tools are present, we let Claude use tools first, then format final response
            if (outputFormat && !hasTools) {
                requestParams.output_format = outputFormat;
            }

            console.log(`[ClaudeNative] Making API call (iteration ${iterationCount}/${maxIterations})`);

            // Use streaming to avoid 10-minute timeout limitation
            // See: https://github.com/anthropics/anthropic-sdk-typescript#long-requests
            const messageStream = client.beta.messages.stream(requestParams);

            // If stream callback provided, forward text chunks
            if (stream) {
                let streamBuffer = '';
                messageStream.on('text', (text) => {
                    streamBuffer += text;
                    if (streamBuffer.length >= stream.chunk_size) {
                        stream.onChunk(streamBuffer);
                        streamBuffer = '';
                    }
                });
            }

            const response = await messageStream.finalMessage();

            console.log(`[ClaudeNative] Response received, stop_reason: ${response.stop_reason}`);

            // Check for refusal
            if (response.stop_reason === 'refusal') {
                throw new Error('Claude refused to generate response for safety reasons');
            }

            // Check for max_tokens cutoff
            if (response.stop_reason === 'max_tokens') {
                console.warn('[ClaudeNative] Response was cut off due to max_tokens limit');
            }

            // Extract tool use blocks
            const toolUseBlocks = response.content.filter(
                (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use'
            );

            // Extract text content
            const textBlocks = response.content.filter(
                (block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text'
            );
            const textContent = textBlocks.map(block => block.text).join('');

            // If there are tool calls, execute them and continue the loop
            if (toolUseBlocks.length > 0 && tools) {
                console.log(`[ClaudeNative] Executing ${toolUseBlocks.length} tool calls`);

                const toolResults = await executeAnthropicToolCalls(toolUseBlocks, tools);
                const toolResultBlocks = formatToolResultsForAnthropic(toolResults);

                // Add assistant response with tool_use blocks to conversation
                // Convert response content to BetaContentBlockParam format
                const assistantContent: Anthropic.Beta.BetaContentBlockParam[] = response.content.map(block => {
                    if (block.type === 'text') {
                        return { type: 'text' as const, text: block.text };
                    } else if (block.type === 'tool_use') {
                        return {
                            type: 'tool_use' as const,
                            id: block.id,
                            name: block.name,
                            input: block.input,
                        };
                    }
                    // Fallback for other types
                    return { type: 'text' as const, text: JSON.stringify(block) };
                });

                currentMessages.push({
                    role: 'assistant',
                    content: assistantContent,
                });

                // Add user message with tool results
                currentMessages.push({
                    role: 'user',
                    content: toolResultBlocks as Anthropic.Beta.BetaContentBlockParam[],
                });

                // Check if any tools returned meaningful results
                const hasResults = toolResults.some(tr => tr.result && !tr.isError);
                if (!hasResults) {
                    console.log('[ClaudeNative] No tool results, continuing...');
                }

                // Continue the loop to get the next response
                continue;
            }

            // No tool calls - this is the final response
            if (stream) {
                stream.onChunk(textContent);
            }

            // If we have a schema, parse and validate the response
            if (schema && schemaName) {
                // If tools were used, we need to make one more call with output_format
                // to get properly structured output
                if (hasTools && textContent) {
                    console.log(`[ClaudeNative] Making final structured output call`);

                    // Add the final response to messages and ask for structured output
                    currentMessages.push({
                        role: 'assistant',
                        content: textContent,
                    });
                    currentMessages.push({
                        role: 'user',
                        content: 'Please provide your response in the required JSON format.',
                    });

                    // Use streaming for final structured output call
                    const structuredStream = client.beta.messages.stream({
                        model: claudeModelName,
                        max_tokens: maxTokens || 16000,
                        temperature: temperature,
                        system: system,
                        messages: currentMessages,
                        betas: ['structured-outputs-2025-11-13'],
                        output_format: outputFormat,
                    });
                    const structuredResponse = await structuredStream.finalMessage();

                    const finalTextContent = structuredResponse.content
                        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
                        .map(block => block.text)
                        .join('');

                    const parsedContent = JSON.parse(finalTextContent);
                    const result = schema.safeParse(parsedContent);

                    if (!result.success) {
                        console.error('[ClaudeNative] Schema validation failed:', result.error.format());
                        throw new InferError(
                            `Anthropic structured output failed schema validation: ${result.error.message}`,
                            finalTextContent
                        );
                    }

                    console.log(`[ClaudeNative] Successfully validated structured response`);
                    return { object: result.data, toolCallContext };
                }

                // Direct structured output (no tools were called)
                try {
                    const parsedContent = JSON.parse(textContent);
                    const result = schema.safeParse(parsedContent);

                    if (!result.success) {
                        console.error('[ClaudeNative] Schema validation failed:', result.error.format());
                        throw new InferError(
                            `Anthropic structured output failed schema validation: ${result.error.message}`,
                            textContent
                        );
                    }

                    console.log(`[ClaudeNative] Successfully validated response against schema`);
                    return { object: result.data, toolCallContext };
                } catch (parseError) {
                    if (parseError instanceof InferError) throw parseError;
                    console.error('[ClaudeNative] Failed to parse JSON response:', parseError);
                    throw new InferError('Failed to parse structured response', textContent);
                }
            }

            // No schema - return as string
            console.log(`[ClaudeNative] Returning string response`);
            return { string: textContent, toolCallContext };
        }

        // Max iterations reached
        console.warn(`[ClaudeNative] Max tool calling depth reached (${maxIterations})`);
        throw new AbortError(`Maximum tool calling depth (${maxDepth}) exceeded`, toolCallContext);

    } catch (error) {
        if (error instanceof Anthropic.APIError) {
            console.error(`[ClaudeNative] Anthropic API error:`, {
                status: error.status,
                message: error.message,
            });

            // Handle specific error cases
            if (error.status === 400) {
                throw new Error(`Anthropic API error: ${error.message}`);
            }
            if (error.status === 429) {
                throw new RateLimitExceededError(
                    'Rate limit exceeded for Anthropic API',
                    RateLimitType.LLM_CALLS
                );
            }
        }
        throw error;
    }
}

export function infer<OutputSchema extends z.AnyZodObject>(
    args: InferArgsStructured,
    toolCallContext?: ToolCallContext,
): Promise<InferResponseObject<OutputSchema>>;

export function infer(args: InferArgsBase, toolCallContext?: ToolCallContext): Promise<InferResponseString>;

export function infer<OutputSchema extends z.AnyZodObject>(
    args: InferWithCustomFormatArgs,
    toolCallContext?: ToolCallContext,
): Promise<InferResponseObject<OutputSchema>>;

/**
 * Perform an inference using OpenAI's structured output with JSON schema
 * This uses the response_format.schema parameter to ensure the model returns
 * a response that matches the provided schema.
 */
export async function infer<OutputSchema extends z.AnyZodObject>({
    env,
    metadata,
    messages,
    schema,
    schemaName,
    actionKey,
    format,
    formatOptions,
    modelName,
    reasoning_effort,
    temperature,
    frequency_penalty,
    maxTokens,
    stream,
    tools,
    runtimeOverrides,
    abortSignal,
    onAssistantMessage,
    completionConfig,
}: InferArgsBase & {
    schema?: OutputSchema;
    schemaName?: string;
    format?: SchemaFormat;
    formatOptions?: FormatterOptions;
}, toolCallContext?: ToolCallContext): Promise<InferResponseObject<OutputSchema> | InferResponseString> {
    if (messages.length > MAX_LLM_MESSAGES) {
        throw new RateLimitExceededError(`Message limit exceeded: ${messages.length} messages (max: ${MAX_LLM_MESSAGES}). Please use context compactification.`, RateLimitType.LLM_CALLS);
    }

    // Check tool calling depth to prevent infinite recursion
    const currentDepth = toolCallContext?.depth ?? 0;
    if (currentDepth >= getMaxToolCallingDepth(actionKey)) {
        console.warn(`Tool calling depth limit reached (${currentDepth}/${getMaxToolCallingDepth(actionKey)}). Stopping recursion.`);
        // Return a response indicating max depth reached
        if (schema) {
            throw new AbortError(`Maximum tool calling depth (${getMaxToolCallingDepth(actionKey)}) exceeded. Tools may be calling each other recursively.`, toolCallContext);
        }
        return {
            string: `[System: Maximum tool calling depth reached.]`,
            toolCallContext
        };
    }

    try {
        const userConfig = await getUserConfigurableSettings(env, metadata.userId)
        // Maybe in the future can expand using config object for other stuff like global model configs?
        await RateLimitService.enforceLLMCallsRateLimit(env, userConfig.security.rateLimit, metadata.userId, modelName)
        const modelConfig = AI_MODEL_CONFIG[modelName as AIModels];

        // Route Claude models to native Anthropic API for:
        // - Structured output with guaranteed schema compliance via constrained decoding
        // - Tool calling with strict: true for guaranteed input schema compliance
        // Only skip when using custom format (which uses prompt-based schema)
        const useNativeAnthropicAPI =
            isClaudeModel(modelName) &&
            !format && // Custom format uses prompt-based approach
            env.ANTHROPIC_API_KEY &&
            (schema || tools); // Either structured output or tool calling

        if (useNativeAnthropicAPI) {
            const hasTools = tools && tools.length > 0;
            const hasSchema = schema && schemaName;
            console.log(`[ModelCall] Routing Claude model to native Anthropic API (schema: ${hasSchema}, tools: ${hasTools})`);

            try {
                const result = await inferWithAnthropicNative<OutputSchema>({
                    env,
                    metadata,
                    messages: optimizeInputs(messages),
                    schema: schema as OutputSchema | undefined,
                    schemaName,
                    modelName,
                    maxTokens,
                    temperature,
                    stream,
                    tools,
                    actionKey,
                    toolCallContext,
                });
                return result;
            } catch (anthropicError) {
                // If Anthropic native API fails (e.g., schema incompatibility), 
                // fall back to OpenAI SDK approach
                console.warn(`[ModelCall] Anthropic native API failed, falling back to OpenAI SDK:`,
                    anthropicError instanceof Error ? anthropicError.message : String(anthropicError));
                // Continue to OpenAI SDK approach below
            }
        }

        const { apiKey, baseURL, defaultHeaders } = await getConfigurationForModel(modelName, env, metadata.userId);
        const provider = modelName.split('/')[0].replace(/\[.*?\]/, '');
        const hasApiKey = apiKey && apiKey.length > 0;
        console.log(`[ModelCall] Provider: ${provider}, Model: ${modelName}, BaseURL: ${baseURL}, HasApiKey: ${hasApiKey}, ApiKeyPrefix: ${hasApiKey ? apiKey.substring(0, 10) + '...' : 'MISSING'}`);

        // Remove [*.] from model name
        modelName = modelName.replace(/\[.*?\]/, '');

        const client = new OpenAI({ apiKey, baseURL: baseURL, defaultHeaders });
        const schemaObj =
            schema && schemaName && !format
                ? { response_format: zodResponseFormat(schema, schemaName) }
                : {};
        // Only add Claude thinking parameters when calling Anthropic directly (not through AI Gateway)
        // AI Gateway's /compat endpoint doesn't support Anthropic-specific extra_body parameters
        const isDirectAnthropicCall = baseURL.includes('api.anthropic.com');
        const extraBody = modelName.includes('claude') && isDirectAnthropicCall ? {
            extra_body: {
                thinking: {
                    type: 'enabled',
                    budget_tokens: claude_thinking_budget_tokens[reasoning_effort ?? 'medium'],
                },
            },
        }
            : {};

        if (modelName.includes('claude')) {
            console.log(`[ClaudeCall] DirectCall: ${isDirectAnthropicCall}, ThinkingEnabled: ${!!extraBody.extra_body}, BaseURL: ${baseURL}`);
        }

        // Optimize messages to reduce token count
        const optimizedMessages = optimizeInputs(messages);
        console.log(`Token optimization: Original messages size ~${JSON.stringify(messages).length} chars, optimized size ~${JSON.stringify(optimizedMessages).length} chars`);

        let messagesToPass = [...optimizedMessages];
        if (toolCallContext && toolCallContext.messages) {
            const ctxMessages = toolCallContext.messages;
            let validToolCallIds = new Set<string>();

            let filtered = ctxMessages.filter(msg => {
                // Update valid IDs when we see assistant with tool_calls
                if (msg.role === 'assistant' && msg.tool_calls) {
                    validToolCallIds = new Set(msg.tool_calls.map(tc => tc.id));
                    return true;
                }

                // Filter tool messages
                if (msg.role === 'tool') {
                    if (!msg.name?.trim()) {
                        console.warn('[TOOL_ORPHAN] Dropping tool message with empty name:', msg.tool_call_id);
                        return false;
                    }
                    if (!msg.tool_call_id || !validToolCallIds.has(msg.tool_call_id)) {
                        console.warn('[TOOL_ORPHAN] Dropping orphaned tool message:', msg.name, msg.tool_call_id);
                        return false;
                    }
                }

                return true;
            });

            // Remove empty tool call arrays from assistant messages
            filtered = filtered.map(msg => {
                if (msg.role === 'assistant' && msg.tool_calls) {
                    msg.tool_calls = msg.tool_calls.filter(tc => tc.id);
                    if (msg.tool_calls.length === 0) {
                        msg.tool_calls = undefined;
                    }
                }
                return msg;
            });

            messagesToPass.push(...filtered);
        }

        if (format) {
            if (!schema || !schemaName) {
                throw new Error('Schema and schemaName are required when using a custom format');
            }
            const formatInstructions = generateTemplateForSchema(
                schema,
                format,
                formatOptions,
            );
            const lastMessage = messagesToPass[messagesToPass.length - 1];

            // Handle multi-modal content properly
            if (typeof lastMessage.content === 'string') {
                // Simple string content - append format instructions
                messagesToPass = [
                    ...messagesToPass.slice(0, -1),
                    {
                        role: lastMessage.role,
                        content: `${lastMessage.content}\n\n${formatInstructions}`,
                    },
                ];
            } else if (Array.isArray(lastMessage.content)) {
                // Multi-modal content - append format instructions to the text part
                const updatedContent = lastMessage.content.map((item) => {
                    if (item.type === 'text') {
                        return {
                            ...item,
                            text: `${item.text}\n\n${formatInstructions}`,
                        };
                    }
                    return item;
                });
                messagesToPass = [
                    ...messagesToPass.slice(0, -1),
                    {
                        role: lastMessage.role,
                        content: updatedContent,
                    },
                ];
            }
        }

        // gpt-5.1 and gpt-5.2 only support temperature 1
        const finalTemperature = (modelName.includes('gpt-5.1') || modelName.includes('gpt-5.2')) ? 1 : temperature;

        console.log(`Running inference with ${modelName} using structured output with ${format} format, reasoning effort: ${reasoning_effort}, max tokens: ${maxTokens}, temperature: ${finalTemperature}, baseURL: ${baseURL}`);

        const toolsOpts = tools ? { tools, tool_choice: 'auto' as const } : {};
        // Responses API returns different types than chat completions
        type ResponsesAPIResponse = Awaited<ReturnType<typeof client.responses.create>>;
        type ResponsesAPIStream = Stream<any>;
        let response: OpenAI.ChatCompletion | OpenAI.ChatCompletionChunk | Stream<OpenAI.ChatCompletionChunk> | ResponsesAPIResponse | ResponsesAPIStream;
        let isResponsesAPI = false;
        if (!modelName.includes('codex')) {
            try {
                // Call OpenAI API with proper structured output format
                response = await client.chat.completions.create({
                    ...schemaObj,
                    ...extraBody,
                    ...toolsOpts,
                    model: modelName,
                    messages: messagesToPass as OpenAI.ChatCompletionMessageParam[],
                    max_completion_tokens: maxTokens || 150000,
                    stream: stream ? true : false,
                    reasoning_effort,
                    temperature: finalTemperature,
                }, {
                    signal: abortSignal,
                    headers: {
                        "cf-aig-metadata": JSON.stringify({
                            chatId: metadata.agentId,
                            userId: metadata.userId,
                            schemaName,
                            actionKey,
                        })
                    }
                });
                console.log(`Inference response received`);
            } catch (error) {
                // Check if error is due to abort
                if (error instanceof Error && (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.includes('abort'))) {
                    console.log('Inference cancelled by user');
                    throw new AbortError('**User cancelled inference**', toolCallContext);
                }

                // Enhanced error logging for model call failures
                const errorInfo = {
                    model: modelName,
                    provider,
                    baseURL,
                    errorName: error instanceof Error ? error.name : 'Unknown',
                    errorMessage: error instanceof Error ? error.message : String(error),
                    httpStatus: (error as any)?.status || (error as any)?.statusCode || 'N/A',
                    errorType: (error as any)?.type || 'N/A',
                    errorCode: (error as any)?.code || 'N/A',
                };
                console.error(`[ModelCallError] Failed to call ${modelName}:`, JSON.stringify(errorInfo, null, 2));

                if ((error instanceof Error && error.message.includes('429')) || (typeof error === 'string' && error.includes('429'))) {
                    throw new RateLimitExceededError('Rate limit exceeded in LLM calls, Please try again later', RateLimitType.LLM_CALLS);
                }
                throw error;
            }
        }
        else {
            isResponsesAPI = true;
            try {
                // Use responses API for Codex models
                // Convert messages to responses API input format
                const responsesInput = convertMessagesToResponsesInput(messagesToPass);

                // Responses API supports tools and schema similar to chat completions
                const responsesParams: any = {
                    model: modelName,
                    input: responsesInput,
                    max_completion_tokens: maxTokens || 150000,
                    temperature: finalTemperature,
                };

                // Add tools if provided
                if (tools) {
                    responsesParams.tools = tools;
                    responsesParams.tool_choice = 'auto';
                }

                // Add response format (schema) if provided
                if (schemaObj.response_format) {
                    responsesParams.response_format = schemaObj.response_format;
                }

                // Only add stream if explicitly requested (responses API handles this differently)
                if (stream) {
                    responsesParams.stream = true;
                }

                response = await client.responses.create(responsesParams, {
                    signal: abortSignal,
                    headers: {
                        "cf-aig-metadata": JSON.stringify({
                            chatId: metadata.agentId,
                            userId: metadata.userId,
                            schemaName,
                            actionKey,
                        })
                    }
                });
                console.log(`Inference response received from responses API`);
            } catch (error) {
                // Check if error is due to abort
                if (error instanceof Error && (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.includes('abort'))) {
                    console.log('Inference cancelled by user');
                    throw new AbortError('**User cancelled inference**', toolCallContext);
                }

                console.error(`Failed to get inference response from OpenAI responses API: ${error}`);
                if ((error instanceof Error && error.message.includes('429')) || (typeof error === 'string' && error.includes('429'))) {
                    throw new RateLimitExceededError('Rate limit exceeded in LLM calls, Please try again later', RateLimitType.LLM_CALLS);
                }
                throw error;
            }
        }
        let toolCalls: ChatCompletionMessageFunctionToolCall[] = [];

        /*
        * Handle LLM response
        */

        let content = '';
        if (stream) {
            // If streaming is enabled, handle the stream response
            if (response instanceof Stream) {
                let streamIndex = 0;

                if (isResponsesAPI) {
                    // Handle responses API streaming format
                    // Accumulators for tool calls: by index (preferred) and by id (fallback when index is missing)
                    const byIndex = new Map<number, ToolAccumulatorEntry>();
                    const byId = new Map<string, ToolAccumulatorEntry>();
                    const orderCounterRef = { value: 0 };

                    for await (const event of response as Stream<any>) {
                        // Responses API streaming events have a different structure
                        // Extract content and tool calls from the event
                        const eventData = event as any;

                        // Handle content delta
                        if (eventData.delta?.content) {
                            const deltaContent = eventData.delta.content;
                            if (deltaContent) {
                                content += deltaContent;
                                const slice = content.slice(streamIndex);
                                if (slice.length >= stream.chunk_size) {
                                    stream.onChunk(slice);
                                    streamIndex += slice.length;
                                }
                            }
                        } else if (eventData.content) {
                            // Some response formats may have content directly
                            const eventContent = eventData.content;
                            if (eventContent) {
                                content += eventContent;
                                const slice = content.slice(streamIndex);
                                if (slice.length >= stream.chunk_size) {
                                    stream.onChunk(slice);
                                    streamIndex += slice.length;
                                }
                            }
                        }

                        // Handle tool calls delta (responses API format)
                        if (eventData.delta?.tool_calls) {
                            try {
                                for (const deltaToolCall of eventData.delta.tool_calls) {
                                    // Convert responses API tool call format to chat completions format
                                    const convertedDelta: ToolCallDelta = {
                                        id: deltaToolCall.id,
                                        index: deltaToolCall.index,
                                        type: 'function',
                                        function: {
                                            name: deltaToolCall.function?.name || '',
                                            arguments: deltaToolCall.function?.arguments || '',
                                        },
                                    };
                                    accumulateToolCallDelta(byIndex, byId, convertedDelta, orderCounterRef);
                                }
                            } catch (error) {
                                console.error('Error processing tool calls in responses API streaming:', error);
                            }
                        }

                        // Check for finish reason
                        if (eventData.done || eventData.finish_reason) {
                            const finalSlice = content.slice(streamIndex);
                            if (finalSlice.length > 0) {
                                stream.onChunk(finalSlice);
                            }
                            break;
                        }
                    }

                    // Assemble toolCalls from responses API stream
                    const assembled = assembleToolCalls(byIndex, byId);
                    const dropped = assembled.filter(tc => !tc.function.name || tc.function.name.trim() === '');
                    if (dropped.length) {
                        console.warn(`[TOOL_CALL_WARNING] Dropping ${dropped.length} streamed tool_call(s) without function name from responses API`, dropped);
                    }
                    toolCalls = assembled.filter(tc => tc.function.name && tc.function.name.trim() !== '');

                    // Validate accumulated tool calls
                    for (const toolCall of toolCalls) {
                        if (!toolCall.function.name) {
                            console.warn('Tool call missing function name:', toolCall);
                        }
                        if (toolCall.function.arguments) {
                            try {
                                const parsed = JSON.parse(toolCall.function.arguments);
                                console.log(`[TOOL_CALL_VALIDATION] Successfully parsed arguments for ${toolCall.function.name}:`, parsed);
                            } catch (error) {
                                console.error(`[TOOL_CALL_VALIDATION] Invalid JSON in tool call arguments for ${toolCall.function.name}:`, {
                                    error: error instanceof Error ? error.message : String(error),
                                    arguments_length: toolCall.function.arguments.length,
                                    arguments_content: toolCall.function.arguments,
                                });
                            }
                        }
                    }
                } else {
                    // Handle chat completions streaming format
                    // Accumulators for tool calls: by index (preferred) and by id (fallback when index is missing)
                    const byIndex = new Map<number, ToolAccumulatorEntry>();
                    const byId = new Map<string, ToolAccumulatorEntry>();
                    const orderCounterRef = { value: 0 };

                    for await (const event of response as Stream<OpenAI.ChatCompletionChunk>) {
                        const delta = (event as ChatCompletionChunk).choices[0]?.delta;

                        // Provider-specific logging
                        const provider = modelName.split('/')[0];
                        if (delta?.tool_calls && (provider === 'google-ai-studio' || provider === 'gemini')) {
                            console.log(`[PROVIDER_DEBUG] ${provider} tool_calls delta:`, JSON.stringify(delta.tool_calls, null, 2));
                        }

                        if (delta?.tool_calls) {
                            try {
                                for (const deltaToolCall of delta.tool_calls as ToolCallsArray) {
                                    accumulateToolCallDelta(byIndex, byId, deltaToolCall, orderCounterRef);
                                }
                            } catch (error) {
                                console.error('Error processing tool calls in streaming:', error);
                            }
                        }

                        // Process content
                        content += delta?.content || '';
                        const slice = content.slice(streamIndex);
                        const finishReason = (event as ChatCompletionChunk).choices[0]?.finish_reason;
                        if (slice.length >= stream.chunk_size || finishReason != null) {
                            stream.onChunk(slice);
                            streamIndex += slice.length;
                        }
                    }

                    // Assemble toolCalls with preference for index ordering, else first-seen order
                    const assembled = assembleToolCalls(byIndex, byId);
                    const dropped = assembled.filter(tc => !tc.function.name || tc.function.name.trim() === '');
                    if (dropped.length) {
                        console.warn(`[TOOL_CALL_WARNING] Dropping ${dropped.length} streamed tool_call(s) without function name`, dropped);
                    }
                    toolCalls = assembled.filter(tc => tc.function.name && tc.function.name.trim() !== '');

                    // Validate accumulated tool calls (do not mutate arguments)
                    for (const toolCall of toolCalls) {
                        if (!toolCall.function.name) {
                            console.warn('Tool call missing function name:', toolCall);
                        }
                        if (toolCall.function.arguments) {
                            try {
                                // Validate JSON arguments early for visibility
                                const parsed = JSON.parse(toolCall.function.arguments);
                                console.log(`[TOOL_CALL_VALIDATION] Successfully parsed arguments for ${toolCall.function.name}:`, parsed);
                            } catch (error) {
                                console.error(`[TOOL_CALL_VALIDATION] Invalid JSON in tool call arguments for ${toolCall.function.name}:`, {
                                    error: error instanceof Error ? error.message : String(error),
                                    arguments_length: toolCall.function.arguments.length,
                                    arguments_content: toolCall.function.arguments,
                                    arguments_hex: Buffer.from(toolCall.function.arguments).toString('hex')
                                });
                            }
                        }
                    }
                }
            } else {
                // Handle the case where stream was requested but a non-stream response was received
                console.error('Expected a stream response but received a non-stream object.');
                if (isResponsesAPI) {
                    // Handle responses API non-stream response
                    const resp = response as unknown as {
                        output?: Array<{ type: string; text?: string; tool_calls?: any[] }>;
                        tool_calls?: any[];
                    };
                    // Extract content from responses API format
                    if (resp.output && Array.isArray(resp.output)) {
                        content = resp.output
                            .filter((item: any) => item.type === 'text')
                            .map((item: any) => item.text || '')
                            .join('\n');

                        // Extract tool calls from output array or top-level
                        const toolCallsFromOutput = resp.output
                            .filter((item: any) => item.tool_calls && Array.isArray(item.tool_calls))
                            .flatMap((item: any) => item.tool_calls);

                        const allToolCallsRaw = toolCallsFromOutput.length > 0 ? toolCallsFromOutput : (resp.tool_calls || []);

                        // Convert responses API tool call format to chat completions format
                        toolCalls = allToolCallsRaw
                            .map((tc: any) => ({
                                id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                                type: 'function' as const,
                                function: {
                                    name: tc.function?.name || tc.name || '',
                                    arguments: typeof tc.function?.arguments === 'string'
                                        ? tc.function.arguments
                                        : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
                                },
                            }))
                            .filter((tc: ChatCompletionMessageFunctionToolCall) => tc.function.name && tc.function.name.trim() !== '');
                    }
                } else {
                    // Handle chat completions non-stream response
                    const completion = response as OpenAI.ChatCompletion;
                    const message = completion.choices[0]?.message;
                    if (message) {
                        content = message.content || '';
                        toolCalls = (message.tool_calls as ChatCompletionMessageFunctionToolCall[]) || [];
                    }
                }
            }
        } else {
            // If not streaming, get the full response content
            if (isResponsesAPI) {
                // Handle responses API non-stream response
                const resp = response as unknown as {
                    output?: Array<{ type: string; text?: string; tool_calls?: any[] }>;
                    tool_calls?: any[];
                    usage?: { total_tokens?: number };
                };
                // Extract content from responses API format
                if (resp.output && Array.isArray(resp.output)) {
                    content = resp.output
                        .filter((item: any) => item.type === 'text')
                        .map((item: any) => item.text || '')
                        .join('\n');

                    // Extract tool calls from output array or top-level
                    const toolCallsFromOutput = resp.output
                        .filter((item: any) => item.tool_calls && Array.isArray(item.tool_calls))
                        .flatMap((item: any) => item.tool_calls);

                    const allToolCallsRaw = toolCallsFromOutput.length > 0 ? toolCallsFromOutput : (resp.tool_calls || []);

                    // Convert responses API tool call format to chat completions format
                    const allToolCalls = allToolCallsRaw
                        .map((tc: any) => ({
                            id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                            type: 'function' as const,
                            function: {
                                name: tc.function?.name || tc.name || '',
                                arguments: typeof tc.function?.arguments === 'string'
                                    ? tc.function.arguments
                                    : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
                            },
                        }))
                        .filter((tc: ChatCompletionMessageFunctionToolCall) => tc.function.name && tc.function.name.trim() !== '');

                    const droppedNonStream = allToolCalls.filter(tc => !tc.function.name || tc.function.name.trim() === '');
                    if (droppedNonStream.length) {
                        console.warn(`[TOOL_CALL_WARNING] Dropping ${droppedNonStream.length} non-stream tool_call(s) without function name from responses API`, droppedNonStream);
                    }
                    toolCalls = allToolCalls.filter(tc => tc.function.name && tc.function.name.trim() !== '');
                }
                // Also print the total number of tokens used if available
                const totalTokens = resp.usage?.total_tokens;
                if (totalTokens) {
                    console.log(`Total tokens used in prompt: ${totalTokens}`);
                }
            } else {
                // Handle chat completions non-stream response
                content = (response as OpenAI.ChatCompletion).choices[0]?.message?.content || '';
                const allToolCalls = ((response as OpenAI.ChatCompletion).choices[0]?.message?.tool_calls as ChatCompletionMessageFunctionToolCall[] || []);
                const droppedNonStream = allToolCalls.filter(tc => !tc.function.name || tc.function.name.trim() === '');
                if (droppedNonStream.length) {
                    console.warn(`[TOOL_CALL_WARNING] Dropping ${droppedNonStream.length} non-stream tool_call(s) without function name`, droppedNonStream);
                }
                toolCalls = allToolCalls.filter(tc => tc.function.name && tc.function.name.trim() !== '');
                // Also print the total number of tokens used in the prompt
                const totalTokens = (response as OpenAI.ChatCompletion).usage?.total_tokens;
                console.log(`Total tokens used in prompt: ${totalTokens}`);
            }
        }

        const assistantMessage = { role: "assistant" as MessageRole, content, tool_calls: toolCalls };

        if (onAssistantMessage) {
            await onAssistantMessage(assistantMessage);
        }

        /*
        * Handle tool calls
        */

        if (!content && !stream && !toolCalls.length) {
            // // Only error if not streaming and no content
            // console.error('No content received from OpenAI', JSON.stringify(response, null, 2));
            // throw new Error('No content received from OpenAI');
            console.warn('No content received from OpenAI', JSON.stringify(response, null, 2));
            return { string: "", toolCallContext };
        }
        let executedToolCalls: ToolCallResult[] = [];
        if (tools) {
            // console.log(`Tool calls:`, JSON.stringify(toolCalls, null, 2), 'definition:', JSON.stringify(tools, null, 2));
            try {
                executedToolCalls = await executeToolCalls(toolCalls, tools);
            } catch (error) {
                console.error(`Tool execution failed${toolCalls.length > 0 ? ` for ${toolCalls[0].function.name}` : ''}:`, error);
                // Check if error is an abort error
                if (error instanceof AbortError) {
                    console.warn(`Tool call was aborted, ending tool call chain with the latest tool call result`);

                    const newToolCallContext = updateToolCallContext(toolCallContext, assistantMessage, executedToolCalls, completionConfig?.detector);
                    return { string: content, toolCallContext: newToolCallContext };
                }
                // Otherwise, continue
            }
        }

        /*
        * Handle tool call results
        */

        if (executedToolCalls.length) {
            console.log(`Tool calls executed:`, JSON.stringify(executedToolCalls, null, 2));

            const newDepth = (toolCallContext?.depth ?? 0) + 1;
            const newToolCallContext = {
                messages: newMessages,
                depth: newDepth
            };

            const executedCallsWithResults = executedToolCalls.filter(result => result.result);
            console.log(`${actionKey}: Tool calling depth: ${newDepth}/${getMaxToolCallingDepth(actionKey)}`);

            if (executedCallsWithResults.length) {
                if (schema && schemaName) {
                    const output = await infer<OutputSchema>({
                        env,
                        metadata,
                        messages,
                        schema,
                        schemaName,
                        format,
                        formatOptions,
                        actionKey,
                        modelName,
                        maxTokens,
                        stream,
                        tools,
                        reasoning_effort,
                        temperature,
                        frequency_penalty,
                        abortSignal,
                        onAssistantMessage,
                        completionConfig,
                    }, newToolCallContext);
                    return output;
                } else {
                    const output = await infer({
                        env,
                        metadata,
                        messages,
                        modelName,
                        maxTokens,
                        actionKey,
                        stream,
                        tools,
                        reasoning_effort,
                        temperature,
                        frequency_penalty,
                        abortSignal,
                        onAssistantMessage,
                        completionConfig,
                    }, newToolCallContext);
                    return output;
                }
            } else {
                console.log('No tool calls with results');
                return { string: content, toolCallContext: newToolCallContext };
            }
        }

        if (!schema) {
            return { string: content, toolCallContext };
        }

        try {
            // Parse the response
            const parsedContent = format
                ? parseContentForSchema(content, format, schema, formatOptions)
                : JSON.parse(content);

            // Use Zod's safeParse for proper error handling
            const result = schema.safeParse(parsedContent);

            if (!result.success) {
                console.log('Raw content:', content);
                console.log('Parsed data:', parsedContent);
                console.error('Schema validation errors:', result.error.format());
                throw new Error(`Failed to validate AI response against schema: ${result.error.message}`);
            }

            return { object: result.data, toolCallContext };
        } catch (parseError) {
            console.error('Error parsing response:', parseError);
            throw new InferError('Failed to parse response', content, toolCallContext);
        }
    } catch (error) {
        if (error instanceof RateLimitExceededError || error instanceof SecurityError) {
            throw error;
        }
        console.error('Error in inferWithSchemaOutput:', error);
        throw error;
    }
}
