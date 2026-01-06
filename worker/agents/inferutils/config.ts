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


export const AGENT_CONFIG: AgentConfig = {
    templateSelection: {
        name: AIModels.CLAUDE_4_5_SONNET,
        max_tokens: 2000,
        fallbackModel: AIModels.OPENAI_5_2,
        temperature: 0.6,
    },
    blueprint: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'medium',
        max_tokens: 64000,
        fallbackModel: AIModels.OPENAI_5_2,
        temperature: 0.7,
    },
    projectSetup: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 10000,
        temperature: 0.2,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    phaseGeneration: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 0.2,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    firstPhaseImplementation: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 64000,
        temperature: 0.2,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    phaseImplementation: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 64000,
        temperature: 0.2,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    realtimeCodeFixer: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    // Not used right now
    fastCodeFixer: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: undefined,
        max_tokens: 64000,
        temperature: 0.0,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    conversationalResponse: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 0,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    deepDebugger: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 0.5,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    codeReview: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'medium',
        max_tokens: 32000,
        temperature: 0.1,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    fileRegeneration: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 0,
        fallbackModel: AIModels.OPENAI_5_2,
    },
    // Not used right now
    screenshotAnalysis: {
        name: AIModels.CLAUDE_4_5_SONNET,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 0.1,
        fallbackModel: AIModels.OPENAI_5_2,
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
