import { ToolDefinition, ErrorResult } from '../types';
import { StructuredLogger } from '../../../logger';
import { CodingAgentInterface } from 'worker/agents/services/implementations/CodingAgent';
import { isBackendReadOnlyFile } from 'worker/services/sandbox/utils';

export type RegenerateFileArgs = {
	path: string;
	issues: string[];
};

export type RegenerateFileResult =
	| { path: string; diff: string }
	| ErrorResult;

export function createRegenerateFileTool(
	agent: CodingAgentInterface,
	logger: StructuredLogger,
): ToolDefinition<RegenerateFileArgs, RegenerateFileResult> {
	return {
		type: 'function' as const,
		function: {
			name: 'regenerate_file',
			description:
				`Autonomous AI agent that applies surgical fixes to code files. Takes file path and array of specific issues to fix. Returns diff showing changes made.

CRITICAL RESTRICTIONS:
- Cannot modify files in api-worker/ or worker/ directories (read-only, auto-deployed)
- Only files in storefront-app/ can be modified
- Backend files are available for reading but cannot be written

CRITICAL: Provide detailed, specific issues - not vague descriptions. See system prompt for full usage guide. These would be implemented by an independent LLM AI agent`,
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					issues: { type: 'array', items: { type: 'string' } },
				},
				required: ['path', 'issues'],
			},
		},
		implementation: async ({ path, issues }) => {
			try {
				// Validate that file is not in read-only directory
				if (isBackendReadOnlyFile(path)) {
					return {
						error: `Cannot regenerate file in read-only directory: ${path}. Backend (api-worker/) and worker routes are read-only and automatically deployed. Only files in storefront-app/ can be modified.`,
					};
				}

				logger.info('Regenerating file', {
					path,
					issuesCount: issues.length,
				});
				return await agent.regenerateFile(path, issues);
			} catch (error) {
				return {
					error:
						error instanceof Error
							? `Failed to regenerate file: ${error.message}`
							: 'Unknown error occurred while regenerating file',
				};
			}
		},
	};
}
