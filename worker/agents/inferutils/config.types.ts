/**
 * Config Types - Pure type definitions only
 * Extracted from config.ts to avoid importing logic code into frontend
 */

import type { ReasoningEffort } from "openai/resources.mjs";
// import { LLMCallsRateLimitConfig } from "../../services/rate-limit/config";

export type { ReasoningEffort };

export enum AIModels {
    DISABLED = 'disabled',

    GEMINI_2_0_FLASH = 'google-ai-studio/gemini-2.0-flash',
    GEMINI_2_5_PRO = 'google-ai-studio/gemini-2.5-pro',
    GEMINI_2_5_FLASH = 'google-ai-studio/gemini-2.5-flash',
    GEMINI_2_5_FLASH_LITE = 'google-ai-studio/gemini-2.5-flash-lite',

    GEMINI_1_5_FLASH_8B = 'google-ai-studio/gemini-1.5-flash-8b-latest',
    GEMINI_2_5_FLASH_LATEST = 'google-ai-studio/gemini-2.5-flash-latest',
    GEMINI_2_5_FLASH_LITE_LATEST = 'google-ai-studio/gemini-2.5-flash-lite-latest',
    GEMINI_2_5_PRO_LATEST = 'google-ai-studio/gemini-2.5-pro-latest',

    GEMINI_2_5_PRO_PREVIEW_05_06 = 'google-ai-studio/gemini-2.5-pro-preview-05-06',
    GEMINI_2_5_FLASH_PREVIEW_04_17 = 'google-ai-studio/gemini-2.5-flash-preview-04-17',
    GEMINI_2_5_FLASH_PREVIEW_05_20 = 'google-ai-studio/gemini-2.5-flash-preview-05-20',
    GEMINI_2_5_PRO_PREVIEW_06_05 = 'google-ai-studio/gemini-2.5-pro-preview-06-05',

    CLAUDE_3_5_SONNET_LATEST = 'anthropic/claude-3-5-sonnet-latest',
    CLAUDE_3_7_SONNET_20250219 = 'anthropic/claude-3-7-sonnet-20250219',
    CLAUDE_4_OPUS = 'anthropic/claude-opus-4-20250514',
    CLAUDE_4_SONNET = 'anthropic/claude-sonnet-4-20250514',
    CLAUDE_4_5_HAIKU = 'anthropic/claude-haiku-4-5',
    CLAUDE_4_5_SONNET = 'anthropic/claude-sonnet-4-5',
    CLAUDE_4_5_OPUS = 'anthropic/claude-opus-4-5',

    OPENAI_O3 = 'openai/o3',
    OPENAI_O4_MINI = 'openai/o4-mini',
    OPENAI_CHATGPT_4O_LATEST = 'openai/chatgpt-4o-latest',
    OPENAI_4_1 = 'openai/gpt-4.1-2025-04-14',
    OPENAI_5 = 'openai/gpt-5',
    OPENAI_5_1 = 'openai/gpt-5.1',
    OPENAI_5_2 = 'openai/gpt-5.2',
    OPENAI_5_3 = 'openai/gpt-5.3',
    OPENAI_5_MINI = 'openai/gpt-5-mini',
    OPENAI_OSS = 'openai/gpt-oss-120b',
    OPENAI_CODEX = 'openai/gpt-5.1-codex',
    OPENAI_CODEX_MAX = 'openai/gpt-5.1-codex-max',
    OPENAI_CODEX_5_3 = 'openai/gpt-5.3-codex',

    OPENROUTER_MINIMAX_M2_5 = 'openrouter/minimax/minimax-m2.5',
    OPENROUTER_MINIMAX_M2_1 = 'openrouter/minimax/minimax-m2.1',
    OPENROUTER_MINIMAX_M1 = 'openrouter/minimax/minimax-m1',

    // OPENROUTER_QWEN_3_CODER = '[openrouter]qwen/qwen3-coder',
    // OPENROUTER_KIMI_2_5 = '[openrouter]moonshotai/kimi-k2',

    // Cerebras models
    CEREBRAS_GPT_OSS = 'cerebras/gpt-oss-120b',
    CEREBRAS_QWEN_3_CODER = 'cerebras/qwen-3-coder-480b',

    // Manus AI models (task-based API)
    MANUS_1_6 = 'manus/manus-1.6',
    MANUS_1_6_LITE = 'manus/manus-1.6-lite',
    MANUS_1_6_MAX = 'manus/manus-1.6-max',
}

export interface AIModelConfig {
    provider: string;
    model: string;
    directOverride?: boolean;
}

const DEFAULT_MODEL_PROVIDER = 'openai';

function parseModelConfig(modelId: AIModels): AIModelConfig {
    const [provider, ...rest] = modelId.split('/');
    if (!provider || rest.length === 0) {
        return {
            provider: DEFAULT_MODEL_PROVIDER,
            model: modelId,
        };
    }
    const model = rest.join('/');
    return {
        provider,
        model,
        directOverride: provider === 'openrouter',
    };
}

export const AI_MODEL_CONFIG: Record<AIModels, AIModelConfig> = Object.values(AIModels).reduce(
    (acc, modelId) => {
        acc[modelId] = parseModelConfig(modelId);
        return acc;
    },
    {} as Record<AIModels, AIModelConfig>
);

export interface ModelConfig {
    name: AIModels | string;
    reasoning_effort?: ReasoningEffort;
    max_tokens?: number;
    temperature?: number;
    fallbackModel?: AIModels | string;
}

export interface AgentConfig {
    templateSelection: ModelConfig;
    blueprint: ModelConfig;
    projectSetup: ModelConfig;
    phaseGeneration: ModelConfig;
    phaseImplementation: ModelConfig;
    firstPhaseImplementation: ModelConfig;
    codeReview: ModelConfig;
    fileRegeneration: ModelConfig;
    screenshotAnalysis: ModelConfig;
    realtimeCodeFixer: ModelConfig;
    fastCodeFixer: ModelConfig;
    conversationalResponse: ModelConfig;
    deepDebugger: ModelConfig;
    guardrailCheck: ModelConfig;
    agenticProjectBuilder: ModelConfig;
}

// Provider and reasoning effort types for validation
export type ProviderOverrideType = 'cloudflare' | 'direct';
export type ReasoningEffortType = 'low' | 'medium' | 'high';

export type AgentActionKey = keyof AgentConfig;

export type InferenceMetadata = {
    agentId: string;
    userId: string;
    // llmRateLimits: LLMCallsRateLimitConfig;
};

export interface CredentialsPayload {
    providers?: Array<{
        provider: string;
        apiKey: string;
    }>;
    aiGateway?: {
        baseUrl?: string;
        token?: string;
    };
    userApiKeys?: Record<string, string>;
}

export interface InferenceRuntimeOverrides {
    userApiKeys?: Record<string, string>;
    aiGatewayOverride?: {
        baseUrl?: string;
        token?: string;
    };
}

export interface InferenceContext {
    agentId?: string;
    userId?: string;
    metadata?: InferenceMetadata;
    userModelConfigs?: Record<AgentActionKey, ModelConfig> | Map<string, ModelConfig>;
    runtimeOverrides?: InferenceRuntimeOverrides;
    enableRealtimeCodeFix?: boolean;
    enableFastSmartCodeFix?: boolean;
    abortSignal?: AbortSignal;
}

export function isValidAIModel(model: string): model is AIModels {
    return Object.values(AIModels).includes(model as AIModels);
}

export function toAIModel(model: string | null | undefined): AIModels | undefined {
    if (!model) {
        return undefined;
    }
    return isValidAIModel(model) ? model : undefined;
}

export function credentialsToRuntimeOverrides(
    credentials?: CredentialsPayload
): InferenceRuntimeOverrides | undefined {
    if (!credentials) {
        return undefined;
    }

    const userApiKeys: Record<string, string> = {
        ...(credentials.userApiKeys || {}),
    };
    for (const provider of credentials.providers || []) {
        if (provider.provider && provider.apiKey) {
            userApiKeys[provider.provider] = provider.apiKey;
        }
    }

    const hasUserApiKeys = Object.keys(userApiKeys).length > 0;
    const hasGatewayOverride = Boolean(credentials.aiGateway?.baseUrl || credentials.aiGateway?.token);
    if (!hasUserApiKeys && !hasGatewayOverride) {
        return undefined;
    }

    return {
        userApiKeys: hasUserApiKeys ? userApiKeys : undefined,
        aiGatewayOverride: hasGatewayOverride
            ? {
                baseUrl: credentials.aiGateway?.baseUrl,
                token: credentials.aiGateway?.token,
            }
            : undefined,
    };
}

/**
 * Configuration for using Manus AI for a specific operation.
 * Manus uses a task-based API with polling, not streaming.
 */
export interface ManusOperationConfig {
    /** Enable Manus for this operation */
    enabled: boolean;
    /** Agent profile to use */
    agentProfile?: 'manus-1.6' | 'manus-1.6-lite' | 'manus-1.6-max';
    /** Timeout in milliseconds for task completion (default: 600000 = 10 min) */
    timeoutMs?: number;
}
