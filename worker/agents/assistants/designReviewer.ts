import Assistant from './assistant';
import {
    ConversationMessage,
    createAssistantMessage,
    createSystemMessage,
    createUserMessage,
    Message,
} from '../inferutils/common';
import { executeInference } from '../inferutils/infer';
import { InferenceContext, ModelConfig } from '../inferutils/config.types';
import { createObjectLogger } from '../../logger';
import type { ToolDefinition } from '../tools/types';
import { CodingAgentInterface } from '../services/implementations/CodingAgent';
import { AGENT_CONFIG } from '../inferutils/config';
import { RenderToolCall } from '../operations/UserConversationProcessor';
import { IdGenerator } from '../utils/idGenerator';
import { InferError } from '../inferutils/core';
import { createDeployPreviewTool } from '../tools/toolkit/deploy-preview';
import { createWaitTool } from '../tools/toolkit/wait';
import { mcpManager } from '../tools/mcpManager';
import { z } from 'zod';

const SYSTEM_PROMPT = `You are a design and UX review specialist with expertise in modern web applications, user experience, visual design, and functional testing.

## Your Role
You are tasked with reviewing a deployed web application by actually using it in a browser. Your goal is to:
1. **Visual Design Review**: Assess the overall look, layout, spacing, typography, colors, and visual hierarchy
2. **Functional Testing**: Test key user flows, interactions, and features to ensure they work as expected
3. **UX Evaluation**: Evaluate user experience, navigation, responsiveness, and accessibility
4. **Issue Identification**: Identify design flaws, usability issues, broken features, or areas for improvement

## Your Approach
- **Be thorough but efficient**: Test the main user flows and key features
- **Take screenshots**: Capture visual evidence of the current state
- **Interact with the site**: Click buttons, fill forms, navigate pages, test interactions
- **Be specific**: When reporting issues, describe exactly what you see and what's wrong
- **Prioritize**: Focus on critical issues first (broken functionality, major design flaws)
- **Be constructive**: Suggest improvements, not just problems

## Available Tools
- **browser_start**: Start or restart the Chrome browser automation service
- **browser_navigate**: Navigate to a URL (use the preview URL provided)
- **browser_screenshot**: Take screenshots of the current page (use this frequently to document the visual state)
- **browser_click**: Click on elements (buttons, links, etc.)
- **browser_type**: Type text into input fields
- **browser_get_content**: Get the text content and structure of the page
- **browser_evaluate**: Execute JavaScript to interact with or inspect the page
- **deploy_preview**: Redeploy the preview if needed (use if site isn't loading)
- **wait**: Wait for a few seconds (useful after navigation or interactions to let page load)

## Workflow
1. **Start browser** (if needed): Use browser_start to ensure browser is running
2. **Navigate to preview URL**: Use browser_navigate with the provided preview URL
3. **Take initial screenshot**: Capture the landing page
4. **Review visual design**: Assess layout, colors, typography, spacing
5. **Test functionality**: 
   - Navigate through the site
   - Click buttons and links
   - Fill out forms (if any)
   - Test key user flows
6. **Take screenshots**: Document different pages and states
7. **Evaluate UX**: Check navigation, responsiveness, user flows
8. **Report findings**: Provide a comprehensive review with specific issues and recommendations

## Communication Style
- Be concise but thorough
- Use screenshots to support your findings
- Describe what you see clearly
- Prioritize issues by severity (critical, major, minor)
- Provide actionable recommendations

## CRITICAL: Final Verdict Format
At the end of your review, you MUST provide a clear verdict in this exact format:

**VERDICT: [STAY_THE_SAME | URGENT_NEEDS]**

If URGENT_NEEDS, follow with:
**ISSUES:**
- [Specific issue 1 with actionable fix]
- [Specific issue 2 with actionable fix]
- [etc.]

**Examples:**
- VERDICT: STAY_THE_SAME
- VERDICT: URGENT_NEEDS
  ISSUES:
  - Navigation menu is broken - buttons don't respond to clicks
  - Homepage layout is misaligned on mobile devices - needs responsive CSS fixes
  - Form submission fails silently - needs error handling

The verdict determines whether the agent will make fixes. Use STAY_THE_SAME only if the design is acceptable. Use URGENT_NEEDS for any issues that need immediate attention.

## Important Notes
- The preview URL may take a moment to load - use wait tool if needed
- If the site doesn't load, try deploy_preview first
- Take multiple screenshots at different stages of interaction
- Test both desktop and mobile views if possible (resize browser)
- Be honest about what works well and what needs improvement
- Always end with the VERDICT format above`;

function USER_PROMPT(previewUrl: string, blueprintDescription?: string): string {
    return `You are reviewing a deployed web application. Your task is to:

1. Navigate to the preview URL: ${previewUrl}
2. Take screenshots to document the visual state
3. Test the functionality by interacting with the site
4. Evaluate the design and user experience
5. Report your findings with specific issues and recommendations

${blueprintDescription ? `\n## Project Context:\n${blueprintDescription}\n` : ''}

**Start by navigating to the preview URL and taking an initial screenshot. Then systematically test the application and document your findings.**

When you're done, provide a comprehensive review report with:
- Overall assessment
- Visual design evaluation
- Functional testing results
- Specific issues found (if any)
- Recommendations for improvements

**CRITICAL: End your report with the VERDICT format:**
**VERDICT: [STAY_THE_SAME | URGENT_NEEDS]**

If URGENT_NEEDS, list specific issues that need fixing.

If you encounter any critical issues that prevent testing, report them immediately with VERDICT: URGENT_NEEDS.`;
}

export interface DesignReviewInputs {
    previewUrl: string;
    blueprintDescription?: string;
}

export interface DesignReviewResult {
    verdict: 'STAY_THE_SAME' | 'URGENT_NEEDS';
    issues: string[];
    fullTranscript: string;
}

/**
 * Parse design review transcript to extract verdict and issues
 */
export function parseDesignReviewVerdict(transcript: string): DesignReviewResult {
    const verdictMatch = transcript.match(/\*\*VERDICT:\s*\[?(STAY_THE_SAME|URGENT_NEEDS)\]?\*\*/i);
    const verdict = verdictMatch ? (verdictMatch[1].toUpperCase() as 'STAY_THE_SAME' | 'URGENT_NEEDS') : 'STAY_THE_SAME';
    
    let issues: string[] = [];
    if (verdict === 'URGENT_NEEDS') {
        // Extract issues after ISSUES: marker
        const issuesMatch = transcript.match(/\*\*ISSUES:\*\*\s*([\s\S]*?)(?=\*\*|$)/i);
        if (issuesMatch) {
            // Split by lines starting with - or *
            issues = issuesMatch[1]
                .split(/\n/)
                .map(line => line.replace(/^[-*]\s*/, '').trim())
                .filter(line => line.length > 0);
        }
        
        // If no structured issues found, try to extract from the transcript
        if (issues.length === 0) {
            // Look for bullet points or numbered lists
            const bulletMatches = transcript.match(/(?:^|\n)[-*]\s+(.+)$/gm);
            if (bulletMatches) {
                issues = bulletMatches.map(m => m.replace(/^[-*]\s+/, '').trim()).filter(m => m.length > 0);
            }
        }
    }
    
    return {
        verdict,
        issues,
        fullTranscript: transcript,
    };
}

export class DesignReviewAssistant extends Assistant<Env> {
    logger = createObjectLogger(this, 'DesignReviewAssistant');
    modelConfigOverride?: ModelConfig;

    constructor(
        env: Env,
        inferenceContext: InferenceContext,
        modelConfigOverride?: ModelConfig,
    ) {
        super(env, inferenceContext);
        this.modelConfigOverride = modelConfigOverride;
    }

    async run(
        inputs: DesignReviewInputs,
        agent: CodingAgentInterface,
        streamCb?: (chunk: string) => void,
        toolRenderer?: RenderToolCall,
    ): Promise<string> {
        const system = createSystemMessage(SYSTEM_PROMPT);
        const user = createUserMessage(
            USER_PROMPT(inputs.previewUrl, inputs.blueprintDescription)
        );
        const messages: Message[] = this.save([system, user]);

        const logger = this.logger;

        // Ensure MCP manager is initialized before getting tools
        await mcpManager.initialize();
        
        // Get MCP tools from MCP manager (includes browser automation tools)
        const mcpToolDefinitions = await mcpManager.getToolDefinitions();
        logger.info(`[DesignReview] Got ${mcpToolDefinitions.length} MCP tool definitions`);
        
        const mcpTools: ToolDefinition<Record<string, unknown>, string>[] = mcpToolDefinitions.map(toolDef => {
            const toolFunction = toolDef.function;
            const toolName = toolFunction?.name ?? 'mcp_tool';
            const toolDescription = toolFunction?.description ?? '';
            const toolParameters = toolFunction?.parameters ?? {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
            };

            return {
                name: toolName,
                description: toolDescription,
                schema: z.object({}).passthrough(),
                resources: () => ({}),
                type: 'function',
                function: {
                    name: toolName,
                    description: toolDescription,
                    parameters: toolParameters,
                },
                openAISchema: {
                    type: 'function',
                    function: {
                        name: toolName,
                        description: toolDescription,
                        parameters: toolParameters,
                    },
                },
                implementation: async (args: Record<string, unknown>) => {
                    logger.info(`[DesignReview] Executing MCP tool: ${toolName}`, { args });
                    try {
                        const result = await mcpManager.executeTool(toolName, args);
                        logger.info(`[DesignReview] MCP tool ${toolName} completed successfully`);
                        return result;
                    } catch (error) {
                        logger.error(`[DesignReview] MCP tool ${toolName} failed`, {
                            error: error instanceof Error ? error.message : String(error),
                            stack: error instanceof Error ? error.stack : undefined,
                        });
                        throw error;
                    }
                },
            };
        });
        
        logger.info(`[DesignReview] Created ${mcpTools.length} MCP tools with implementations`);

        const otherTools = [
            createDeployPreviewTool(agent, logger),
            createWaitTool(logger),
        ];

        const rawTools = [...mcpTools, ...otherTools];
        
        // Attach tool renderer for UI visualization if provided
        const tools: ToolDefinition<any, any>[] = toolRenderer
            ? rawTools.map(td => ({
                ...td,
                onStart: (args: Record<string, unknown>) => toolRenderer({ 
                    name: td.name, 
                    status: 'start', 
                    args 
                }),
                onComplete: (args: Record<string, unknown>, result: unknown) => toolRenderer({ 
                    name: td.name, 
                    status: 'success', 
                    args,
                    result: typeof result === 'string' ? result : JSON.stringify(result)
                })
            }))
            : rawTools;

        let out = '';

        try {
            const result = await executeInference({
                env: this.env,
                context: this.inferenceContext,
                agentActionName: 'deepDebugger', // Use deepDebugger config (similar use case)
                modelConfig: this.modelConfigOverride || AGENT_CONFIG.deepDebugger,
                messages,
                tools,
                stream: streamCb
                    ? { chunk_size: 64, onChunk: (c) => streamCb(c) }
                    : undefined,
            });
            out = result.string || '';
        } catch (e) {
            // If error is an infererror, use the partial response transcript
            if (e instanceof InferError) {
                out = e.partialResponseTranscript();
                logger.info('Partial response transcript', { transcript: out });
            } else {
                throw e;
            }
        }

        this.save([createAssistantMessage(out)]);
        return out;
    }

    getTranscript(): ConversationMessage[] {
        return this.getHistory().map((m) => ({
            ...m,
            conversationId: IdGenerator.generateConversationId(),
        }));
    }
}
