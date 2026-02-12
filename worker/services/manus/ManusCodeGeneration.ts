/**
 * Manus Code Generation
 * 
 * Specialized functions for using Manus to generate code files.
 * Handles prompt building, file extraction, and result processing.
 */

import { createLogger } from '../../logger';
import { ManusService } from './ManusService';
import {
    ManusAgentProfile,
    ManusCodeGenerationResult,
    ManusGeneratedFile,
    ManusTaskOutput,
} from './ManusTypes';

const logger = createLogger('ManusCodeGeneration');

// ============================================================================
// Types
// ============================================================================

export interface ManusCodeGenerationRequest {
    /** The main prompt/instruction for code generation */
    prompt: string;
    /** Codebase files to provide as context */
    codebaseFiles: Array<{ path: string; content: string }>;
    /** Agent profile to use (default: manus-1.6) */
    agentProfile?: ManusAgentProfile;
    /** Called with progress updates during polling */
    onProgress?: (message: string) => void;
    /** Abort signal for cancellation */
    abortSignal?: AbortSignal;
    /** Maximum time to wait for completion in ms (default: 600000 = 10 min) */
    timeoutMs?: number;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Execute code generation using Manus API
 */
export async function executeManusCodeGeneration(
    env: Env,
    request: ManusCodeGenerationRequest
): Promise<ManusCodeGenerationResult> {
    // Check for API key
    if (!env.MANUS_API_KEY) {
        logger.error('MANUS_API_KEY not configured');
        return {
            success: false,
            error: 'MANUS_API_KEY not configured. Please add your Manus API key to the environment.',
        };
    }

    const manus = new ManusService(env.MANUS_API_KEY);

    try {
        // Build the full prompt with codebase context
        const fullPrompt = buildCodeGenerationPrompt(request.prompt, request.codebaseFiles);

        logger.info('Starting Manus code generation', {
            promptLength: fullPrompt.length,
            fileCount: request.codebaseFiles.length,
            agentProfile: request.agentProfile || 'manus-1.6',
        });

        // Report progress
        request.onProgress?.('Creating Manus task...');

        // Create the task
        const task = await manus.createTask({
            prompt: fullPrompt,
            agentProfile: request.agentProfile || 'manus-1.6',
            task_mode: 'agent',
            hide_in_task_list: true, // Don't clutter user's task list
        });

        logger.info('Manus task created', {
            taskId: task.task_id,
            taskUrl: task.task_url
        });

        request.onProgress?.(`Task created: ${task.task_id}`);

        // Wait for completion
        const result = await manus.waitForCompletion(task.task_id, {
            pollIntervalMs: 5000,
            timeoutMs: request.timeoutMs || 600000, // 10 minutes default
            abortSignal: request.abortSignal,
            onProgress: (status) => {
                request.onProgress?.(`Task status: ${status.status}`);
            },
        });

        // Handle failure
        if (result.status === 'failed') {
            logger.error('Manus task failed', {
                taskId: task.task_id,
                error: result.error
            });
            return {
                success: false,
                error: result.error || 'Manus task failed',
                taskId: task.task_id,
                taskUrl: task.task_url,
            };
        }

        // Extract generated files from output
        const files = extractFilesFromOutput(result.output);
        const rawOutput = extractTextFromOutput(result.output);

        logger.info('Manus code generation completed', {
            taskId: task.task_id,
            fileCount: files.length,
            outputLength: rawOutput.length,
        });

        return {
            success: true,
            files,
            rawOutput,
            taskId: task.task_id,
            taskUrl: task.task_url,
        };

    } catch (error) {
        logger.error('Manus code generation failed', { error });
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build a code generation prompt that includes codebase context
 */
function buildCodeGenerationPrompt(
    userPrompt: string,
    files: Array<{ path: string; content: string }>
): string {
    // Limit context size to avoid token limits
    const maxContextChars = 100000;
    let currentSize = 0;
    const includedFiles: Array<{ path: string; content: string }> = [];

    // Sort files by importance (config files, main files first)
    const sortedFiles = [...files].sort((a, b) => {
        const importance = (path: string) => {
            if (path.includes('package.json')) return 0;
            if (path.includes('tsconfig')) return 1;
            if (path.includes('tailwind.config')) return 2;
            if (path.endsWith('.ts') || path.endsWith('.tsx')) return 3;
            if (path.endsWith('.liquid')) return 4;
            if (path.endsWith('.css')) return 5;
            return 6;
        };
        return importance(a.path) - importance(b.path);
    });

    // Include files up to the limit
    for (const file of sortedFiles) {
        const fileText = `\n=== ${file.path} ===\n${file.content}\n`;
        if (currentSize + fileText.length > maxContextChars) {
            logger.info('Truncating codebase context', {
                includedFiles: includedFiles.length,
                totalFiles: files.length,
            });
            break;
        }
        includedFiles.push(file);
        currentSize += fileText.length;
    }

    const filesContext = includedFiles.map(f =>
        `=== ${f.path} ===\n${f.content}`
    ).join('\n\n');

    return `You are an expert code generation agent. You are given a codebase and a task to implement.

<CODEBASE>
${filesContext}
</CODEBASE>

<TASK>
${userPrompt}
</TASK>

<INSTRUCTIONS>
Generate the necessary code files to complete the task. For each file you create or modify, output it in this exact format:

--- FILE: path/to/file.ext ---
(complete file content here)
--- END FILE ---

Important:
- Output the complete file content, not diffs
- Include all necessary imports and exports
- Follow the existing code style and conventions
- Use only the dependencies already present in package.json
- Make sure the code is production-ready and error-free
</INSTRUCTIONS>

Now implement the task. Output each file you create or modify:`;
}

// ============================================================================
// Output Parsing
// ============================================================================

/**
 * Extract generated files from Manus task output
 */
function extractFilesFromOutput(output: ManusTaskOutput[]): ManusGeneratedFile[] {
    const files: ManusGeneratedFile[] = [];

    for (const item of output) {
        if (item.role !== 'assistant') continue;

        for (const content of item.content) {
            if (content.type === 'output_text' && 'text' in content && content.text) {
                // Parse file blocks from text output
                const extractedFiles = parseFileBlocks(content.text);
                files.push(...extractedFiles);
            }

            // Handle file attachments if present
            if (content.type === 'output_file' && 'fileUrl' in content) {
                // Note: Would need to fetch file content from URL
                // For now, log a warning
                logger.warn('File attachment in Manus output not yet supported', {
                    fileName: (content as any).fileName,
                    fileUrl: (content as any).fileUrl,
                });
            }
        }
    }

    return files;
}

/**
 * Parse file blocks from text output
 */
function parseFileBlocks(text: string): ManusGeneratedFile[] {
    const files: ManusGeneratedFile[] = [];

    // Match file blocks: --- FILE: path --- ... --- END FILE ---
    const fileRegex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/gi;

    let match;
    while ((match = fileRegex.exec(text)) !== null) {
        const path = match[1].trim();
        const content = match[2].trim();

        if (path && content) {
            files.push({ path, content });
            logger.debug('Extracted file from Manus output', { path, contentLength: content.length });
        }
    }

    // Also try alternative format: ```filename ... ```
    if (files.length === 0) {
        const codeBlockRegex = /```(\w+)?\s*\n?([^\n]+\.(ts|tsx|js|jsx|css|liquid|html|json))\n([\s\S]*?)```/gi;
        while ((match = codeBlockRegex.exec(text)) !== null) {
            const path = match[2].trim();
            const content = match[4].trim();
            if (path && content && !files.some(f => f.path === path)) {
                files.push({ path, content });
                logger.debug('Extracted file from code block', { path, contentLength: content.length });
            }
        }
    }

    return files;
}

/**
 * Extract raw text output from Manus task output
 */
function extractTextFromOutput(output: ManusTaskOutput[]): string {
    const parts: string[] = [];

    for (const item of output) {
        if (item.role !== 'assistant') continue;

        for (const content of item.content) {
            if (content.type === 'output_text' && 'text' in content && content.text) {
                parts.push(content.text);
            }
        }
    }

    return parts.join('\n\n');
}
