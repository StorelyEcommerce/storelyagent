import { AgentConfig, AIModels } from "./config.types";

/*
Use these configs instead for better performance, less bugs and costs:

    blueprint: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'medium',
        max_tokens: 16000,
        fallbackModel: AIModels.OPENAI_O3,
        temperature: 1,
    },
    projectSetup: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'medium',
        max_tokens: 10000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
    },
    phaseGeneration: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'medium',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
    },
    codeReview: {
        name: AIModels.OPENAI_5,
        reasoning_effort: 'medium',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },
    fileRegeneration: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.CLAUDE_4_SONNET,
    },
    realtimeCodeFixer: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.CLAUDE_4_SONNET,
    },

For real time code fixer, here are some alternatives: 
    realtimeCodeFixer: {
        name: AIModels.CEREBRAS_QWEN_3_CODER,
        reasoning_effort: undefined,
        max_tokens: 10000,
        temperature: 0.0,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },

OR
    realtimeCodeFixer: {
        name: AIModels.KIMI_2_5,
        providerOverride: 'direct',
        reasoning_effort: 'medium',
        max_tokens: 32000,
        temperature: 0.7,
        fallbackModel: AIModels.OPENAI_OSS,
    },
*/


const DEFAULT_PRIMARY_MODEL = AIModels.OPENAI_CODEX_5_3;
const DEFAULT_FALLBACK_MODEL = AIModels.OPENAI_5_2;

export const AGENT_CONFIG: AgentConfig = {
    templateSelection: {
        name: DEFAULT_PRIMARY_MODEL,
        max_tokens: 2000,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
        temperature: 0.95,
    },
    blueprint: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'medium',
        max_tokens: 64000,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
        temperature: 0.95,
    },
    projectSetup: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 10000,
        temperature: 0.2,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    phaseGeneration: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 0.85,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    firstPhaseImplementation: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 64000,
        temperature: 0.2,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    phaseImplementation: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 64000,
        temperature: 0.2,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    realtimeCodeFixer: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    // Not used right now
    fastCodeFixer: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: undefined,
        max_tokens: 64000,
        temperature: 0.0,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    conversationalResponse: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 0,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    deepDebugger: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 0.5,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    codeReview: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'medium',
        max_tokens: 32000,
        temperature: 0.1,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    fileRegeneration: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 0,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    // Not used right now
    screenshotAnalysis: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 0.1,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
    guardrailCheck: {
        name: DEFAULT_PRIMARY_MODEL,
        reasoning_effort: 'low',
        max_tokens: 1000,
        temperature: 0,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
    },
};


// Model validation utilities
export const ALL_AI_MODELS: readonly AIModels[] = Object.values(AIModels);
export type AIModelType = AIModels;

// Create tuple type for Zod enum validation
export const AI_MODELS_TUPLE = Object.values(AIModels) as [AIModels, ...AIModels[]];

export function isValidAIModel(model: string): model is AIModels {
    return Object.values(AIModels).includes(model as AIModels);
}

export function getValidAIModelsArray(): readonly AIModels[] {
    return ALL_AI_MODELS;
}
