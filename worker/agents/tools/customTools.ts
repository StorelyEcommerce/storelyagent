import type { ToolDefinition } from './types';
import { StructuredLogger, createLogger } from '../../logger';
import { RenderToolCall } from '../operations/UserConversationProcessor';
import { toolWebSearchDefinition } from './toolkit/web-search';
import { toolFeedbackDefinition } from './toolkit/feedback';
import { createQueueRequestTool } from './toolkit/queue-request';
import { createGetLogsTool } from './toolkit/get-logs';
import { createDeployPreviewTool } from './toolkit/deploy-preview';
import { createDeepDebuggerTool } from "./toolkit/deep-debugger";
import { createRenameProjectTool } from './toolkit/rename-project';
import { createAlterBlueprintTool } from './toolkit/alter-blueprint';
import { createReadFilesTool } from './toolkit/read-files';
import { createExecCommandsTool } from './toolkit/exec-commands';
import { createRunAnalysisTool } from './toolkit/run-analysis';
import { createRegenerateFileTool } from './toolkit/regenerate-file';
import { createGenerateFilesTool } from './toolkit/generate-files';
import { createWaitTool } from './toolkit/wait';
import { createGetRuntimeErrorsTool } from './toolkit/get-runtime-errors';
import { createWaitForGenerationTool } from './toolkit/wait-for-generation';
import { createWaitForDebugTool } from './toolkit/wait-for-debug';
import { createGitTool } from './toolkit/git';
import { mcpManager } from './mcpManager';

const buildToolsLogger = createLogger('buildTools');

export async function executeToolWithDefinition<TArgs, TResult>(
    toolCall: ChatCompletionMessageFunctionToolCall,
    toolDef: ToolDefinition<TArgs, TResult>,
    args: TArgs
): Promise<TResult> {
    await toolDef.onStart?.(toolCall, args);
    const result = await toolDef.implementation(args);
    await toolDef.onComplete?.(toolCall, args, result);
    return result;
}

/**
 * Build all available tools for the agent
 * Add new tools here - they're automatically included in the conversation
 */
export async function buildTools(
    agent: CodingAgentInterface,
    logger: StructuredLogger,
    toolRenderer: RenderToolCall,
    streamCb: (chunk: string) => void,
): Promise<ToolDefinition<any, any>[]> {
    // Initialize MCP manager early to show logs and connect to available servers
    // This happens when tools are built (before inference)
    // We await it here so tool names are visible in logs before LLM calls
    buildToolsLogger.info('========================================');
    buildToolsLogger.info('Building tools and initializing MCP manager...');
    buildToolsLogger.info('========================================');
    logger.info('Building tools and initializing MCP manager...');
    
    // Initialize MCP manager (await to ensure tools are discovered before LLM calls)
    try {
        await mcpManager.initialize();
        buildToolsLogger.info('MCP manager initialization completed');
        logger.info('MCP manager initialization completed');
        
        // Log available MCP tools for visibility
        const availableTools = mcpManager.getAvailableToolNames();
        if (availableTools.length > 0) {
            buildToolsLogger.info(`[MCP] Available MCP tools: ${availableTools.join(', ')}`);
            logger.info(`[MCP] Available MCP tools: ${availableTools.join(', ')}`);
        }
    } catch (error) {
        buildToolsLogger.warn('MCP manager initialization failed (non-critical)', { 
            error: error instanceof Error ? error.message : String(error) 
        });
        logger.warn('MCP manager initialization failed (non-critical)', { 
            error: error instanceof Error ? error.message : String(error) 
        });
    }
    
    return [
        toolWebSearchDefinition,
        toolFeedbackDefinition,
        createQueueRequestTool(agent, logger),
        createGetLogsTool(agent, logger),
        createDeployPreviewTool(agent, logger),
        createWaitForGenerationTool(agent, logger),
        createWaitForDebugTool(agent, logger),
        createRenameProjectTool(agent, logger),
        createAlterBlueprintTool(agent, logger),
        // Git tool (safe version - no reset for user conversations)
        createGitTool(agent, logger, { excludeCommands: ['reset'] }),
        // Deep autonomous debugging assistant tool
        createDeepDebuggerTool(agent, logger, toolRenderer, streamCb),
    ];
}

export function buildDebugTools(session: DeepDebuggerSession, logger: StructuredLogger, toolRenderer?: RenderToolCall): ToolDefinition<any, any>[] {
    const tools = [
        createGetLogsTool(session.agent, logger),
        createGetRuntimeErrorsTool(session.agent, logger),
        createReadFilesTool(session.agent, logger),
        createRunAnalysisTool(session.agent, logger),
        createExecCommandsTool(session.agent, logger),
        createRegenerateFileTool(session.agent, logger),
        createGenerateFilesTool(session.agent, logger),
        createDeployPreviewTool(session.agent, logger),
        createWaitTool(logger),
        createGitTool(session.agent, logger),
    ];
    return withRenderer(tools, toolRenderer);
}

/**
 * Decorate tools with renderer for UI visualization and conversation sync
 */
export function withRenderer(
    tools: ToolDefinition<any, any>[],
    toolRenderer?: RenderToolCall,
    onComplete?: (message: Message) => Promise<void>
): ToolDefinition<any, any>[] {
    if (!toolRenderer) return tools;

    return tools.map(td => {
        const originalOnStart = td.onStart;
        const originalOnComplete = td.onComplete;

        return {
            ...td,
            onStart: async (tc: ChatCompletionMessageFunctionToolCall, args: Record<string, unknown>) => {
                await originalOnStart?.(tc, args);
                if (toolRenderer) {
                    toolRenderer({ name: td.name, status: 'start', args });
                }
            },
            onComplete: async (tc: ChatCompletionMessageFunctionToolCall, args: Record<string, unknown>, result: unknown) => {
                await originalOnComplete?.(tc, args, result);
                if (toolRenderer) {
                    toolRenderer({
                        name: td.name,
                        status: 'success',
                        args,
                        result: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }
                if (onComplete) {
                    const toolMessage: Message = {
                        role: 'tool',
                        content: typeof result === 'string' ? result : JSON.stringify(result),
                        name: td.name,
                        tool_call_id: tc.id,
                    };
                    await onComplete(toolMessage);
                }
            }
        };
    });
}
