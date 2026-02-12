import { tool, t, ErrorResult } from '../types';
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
	agent: ICodingAgent,
	logger: StructuredLogger,
) {
	return tool({
		name: 'regenerate_file',
		description:
			`Autonomous AI agent that applies surgical fixes to code files. Takes file path and array of specific issues to fix. Returns diff showing changes made.

CRITICAL RESTRICTIONS:
- Cannot modify files in api-worker/ or worker/ directories (read-only, auto-deployed)
- Only files in storefront-app/ can be modified
- Backend files are available for reading but cannot be written

CRITICAL: Provide detailed, specific issues - not vague descriptions. See system prompt for full usage guide. These would be implemented by an independent LLM AI agent`,
		args: {
			path: t.file.write().describe('Relative path to file from project root'),
			issues: t.array(t.string()).describe('Specific, detailed issues to fix in the file'),
		},
		run: async ({ path, issues }) => {
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
				return await agent.regenerateFileByPath(path, issues);
			} catch (error) {
				return {
					error:
						error instanceof Error
							? `Failed to regenerate file: ${error.message}`
							: 'Unknown error occurred while regenerating file',
				};
			}
		},
	});
}
