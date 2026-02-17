import type { ICodingAgent } from '../interfaces/ICodingAgent';
import type { FileOutputType, FileConceptType, Blueprint } from 'worker/agents/schemas';
import type { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';
import type {
	ExecuteCommandsResponse,
	PreviewType,
	StaticAnalysisResponse,
	RuntimeError,
	TemplateFile,
} from 'worker/services/sandbox/sandboxTypes';
import type { ProcessedImageAttachment } from 'worker/types/image-attachment';
import type { BehaviorType, DeepDebugResult, DeploymentTarget, ProjectType } from 'worker/agents/core/types';
import type { RenderToolCall } from 'worker/agents/operations/UserConversationProcessor';
import type { WebSocketMessageType, WebSocketMessageData } from 'worker/api/websocketTypes';
import type { GitVersionControl } from 'worker/agents/git/git';
import type { OperationOptions } from 'worker/agents/operations/common';

export class CodingAgentInterface implements ICodingAgent {
	constructor(private readonly agent: ICodingAgent) {}

	getBehavior(): BehaviorType {
		return this.agent.getBehavior();
	}

	isMVPGenerated(): boolean {
		return this.agent.isMVPGenerated();
	}

	setMVPGenerated(): boolean {
		return this.agent.setMVPGenerated();
	}

	getLogs(reset?: boolean, durationSeconds?: number): Promise<string> {
		return this.agent.getLogs(reset, durationSeconds);
	}

	fetchRuntimeErrors(clear?: boolean): Promise<RuntimeError[]> {
		return this.agent.fetchRuntimeErrors(clear);
	}

	deployToSandbox(files?: FileOutputType[], redeploy?: boolean, commitMessage?: string, clearLogs?: boolean): Promise<PreviewType | null> {
		return this.agent.deployToSandbox(files, redeploy, commitMessage, clearLogs);
	}

	broadcast<T extends WebSocketMessageType>(msg: T, data?: WebSocketMessageData<T>): void {
		this.agent.broadcast(msg, data);
	}

	deployToCloudflare(target?: DeploymentTarget): Promise<{ deploymentUrl?: string; workersUrl?: string } | null> {
		return this.agent.deployToCloudflare(target);
	}

	queueUserRequest(request: string, images?: ProcessedImageAttachment[]): void {
		this.agent.queueUserRequest(request, images);
	}

	clearConversation(): void {
		this.agent.clearConversation();
	}

	deployPreview(clearLogs?: boolean, forceRedeploy?: boolean): Promise<string> {
		return this.agent.deployPreview(clearLogs, forceRedeploy);
	}

	updateProjectName(newName: string): Promise<boolean> {
		return this.agent.updateProjectName(newName);
	}

	setBlueprint(blueprint: Blueprint): Promise<void> {
		return this.agent.setBlueprint(blueprint);
	}

	getProjectType(): ProjectType {
		return this.agent.getProjectType();
	}

	importTemplate(templateName: string): Promise<{ templateName: string; filesImported: number; files: TemplateFile[] }> {
		return this.agent.importTemplate(templateName);
	}

	getOperationOptions(): OperationOptions {
		return this.agent.getOperationOptions();
	}

	listFiles(): FileOutputType[] {
		return this.agent.listFiles();
	}

	readFiles(paths: string[]): Promise<{ files: { path: string; content: string }[] }> {
		return this.agent.readFiles(paths);
	}

	deleteFiles(paths: string[]): Promise<{ success: boolean; error?: string }> {
		return this.agent.deleteFiles(paths);
	}

	runStaticAnalysisCode(files?: string[]): Promise<StaticAnalysisResponse> {
		return this.agent.runStaticAnalysisCode(files);
	}

	execCommands(commands: string[], shouldSave: boolean, timeout?: number): Promise<ExecuteCommandsResponse> {
		return this.agent.execCommands(commands, shouldSave, timeout);
	}

	updateBlueprint(patch: Partial<Blueprint>): Promise<Blueprint> {
		return this.agent.updateBlueprint(patch);
	}

	generateFiles(
		phaseName: string,
		phaseDescription: string,
		requirements: string[],
		files: FileConceptType[]
	): Promise<{ files: Array<{ path: string; purpose: string; diff: string }> }> {
		return this.agent.generateFiles(phaseName, phaseDescription, requirements, files);
	}

	regenerateFileByPath(path: string, issues: string[]): Promise<{ path: string; diff: string }> {
		return this.agent.regenerateFileByPath(path, issues);
	}

	isCodeGenerating(): boolean {
		return this.agent.isCodeGenerating();
	}

	waitForGeneration(): Promise<void> {
		return this.agent.waitForGeneration();
	}

	isDeepDebugging(): boolean {
		return this.agent.isDeepDebugging();
	}

	waitForDeepDebug(): Promise<void> {
		return this.agent.waitForDeepDebug();
	}

	executeDeepDebug(
		issue: string,
		toolRenderer: RenderToolCall,
		streamCb: (chunk: string) => void,
		focusPaths?: string[]
	): Promise<DeepDebugResult> {
		return this.agent.executeDeepDebug(issue, toolRenderer, streamCb, focusPaths);
	}

	get git(): GitVersionControl {
		return this.agent.git;
	}

	getSandboxServiceClient(): BaseSandboxService {
		return this.agent.getSandboxServiceClient();
	}
}
