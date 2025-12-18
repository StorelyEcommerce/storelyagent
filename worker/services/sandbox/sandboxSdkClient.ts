import { getSandbox, Sandbox, parseSSEStream, LogEvent, ExecResult } from '@cloudflare/sandbox';

import {
    BootstrapResponse,
    GetInstanceResponse,
    BootstrapStatusResponse,
    ShutdownResponse,
    WriteFilesRequest,
    WriteFilesResponse,
    GetFilesResponse,
    ExecuteCommandsResponse,
    RuntimeErrorResponse,
    ClearErrorsResponse,
    StaticAnalysisResponse,
    DeploymentResult,
    FileTreeNode,
    RuntimeError,
    CommandExecutionResult,
    CodeIssue,
    InstanceDetails,
    LintSeverity,
    GetLogsResponse,
    ListInstancesResponse,
    StoredError,
} from './sandboxTypes';

import { createObjectLogger } from '../../logger';
import { env } from 'cloudflare:workers'
import { BaseSandboxService } from './BaseSandboxService';

import {
    buildDeploymentConfig,
    parseWranglerConfig,
    deployToDispatch,
} from '../deployer/deploy';
import {
    createAssetManifest
} from '../deployer/utils/index';
import { generateId } from '../../utils/idGenerator';
import { ResourceProvisioner } from './resourceProvisioner';
import { TemplateParser } from './templateParser';
import { ResourceProvisioningResult } from './types';
import { getPreviewDomain } from '../../utils/urls';
import { isDev } from 'worker/utils/envs'
import { FileTreeBuilder } from './fileTreeBuilder';
// Export the Sandbox class in your Worker
export { Sandbox as UserAppSandboxService, Sandbox as DeployerService } from "@cloudflare/sandbox";


interface InstanceMetadata {
    templateName: string;
    projectName: string;
    startTime: string;
    webhookUrl?: string;
    previewURL?: string;
    tunnelURL?: string;
    processId?: string;
    allocatedPort?: number;
    donttouch_files: string[];
    redacted_files: string[];
}

type SandboxType = Sandbox;

type ExecutionSession = Awaited<ReturnType<Sandbox['createSession']>>;

/**
 * Streaming event for enhanced command execution
 */
export interface StreamEvent {
    type: 'stdout' | 'stderr' | 'exit' | 'error';
    data?: string;
    code?: number;
    error?: string;
    timestamp: Date;
}

export enum AllocationStrategy {
    MANY_TO_ONE = 'many_to_one',
    ONE_TO_ONE = 'one_to_one',
}

function getAutoAllocatedSandbox(sessionId: string): string {
    // Distribute sessions across available containers using consistent hashing
    // Convert session ID to hash for deterministic assignment
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
        const char = sessionId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }

    hash = Math.abs(hash);

    const max_instances = env.MAX_SANDBOX_INSTANCES ? Number(env.MAX_SANDBOX_INSTANCES) : 10;
    const containerIndex = hash % max_instances;
    const containerId = `container-pool-${containerIndex}`;

    console.log(`Session mapped to container`, { sessionId, containerId, hash, containerIndex });
    return containerId;
}

export class SandboxSdkClient extends BaseSandboxService {
    private sandbox: SandboxType;
    private metadataCache = new Map<string, InstanceMetadata>();
    private sessionCache = new Map<string, ExecutionSession>();

    constructor(sandboxId: string, agentId: string) {
        if (env.ALLOCATION_STRATEGY === AllocationStrategy.MANY_TO_ONE) {
            sandboxId = getAutoAllocatedSandbox(sandboxId);
        }
        super(sandboxId);
        this.sandbox = this.getSandbox();

        this.logger = createObjectLogger(this, 'SandboxSdkClient');
        this.logger.setFields({
            sandboxId: this.sandboxId,
            agentId,
        });
        this.logger.info('SandboxSdkClient initialized', { sandboxId: this.sandboxId });
    }

    async initialize(): Promise<void> {
        // Initialize default session for sandbox operations
        await this.getDefaultSession();

        // Run a echo command to check if the sandbox is working
        const echoResult = await this.safeSandboxExec('echo "Hello World"');
        if (echoResult.exitCode !== 0) {
            throw new Error(`Failed to run echo command: ${echoResult.stderr}`);
        }
        this.logger.info('Sandbox initialization complete');
    }

    private getWranglerKVKey(instanceId: string): string {
        return `wrangler-${instanceId}`;
    }

    private getSandbox(): SandboxType {
        if (!this.sandbox) {
            this.sandbox = getSandbox(env.Sandbox, this.sandboxId);
        }
        return this.sandbox;
    }

    /**
     * Generic session getter with caching and automatic recovery
     * Properly handles existing sessions and ensures correct cwd
     */
    private async getOrCreateSession(sessionId: string, cwd: string): Promise<ExecutionSession> {
        try {
            // Try to create a new session with the specified cwd
            this.logger.info('Creating new session', { sessionId, cwd });
            const session = await this.getSandbox().createSession({ id: sessionId, cwd });
            return session;
        } catch (error) {
            // If session already exists, get it
            this.logger.info('Session already exists, retrieving it', { sessionId, cwd });
            const existingSession = await this.getSandbox().getSession(sessionId);

            // Verify the cwd matches what we expect
            const pwdResult = await existingSession.exec('pwd');
            const actualCwd = pwdResult.stdout.trim();

            if (actualCwd !== cwd) {
                this.logger.warn('Existing session has wrong cwd, attempting to change directory', {
                    sessionId,
                    expectedCwd: cwd,
                    actualCwd
                });
                // Try to cd to the correct directory
                await existingSession.exec(`cd ${cwd}`);
                const verifyResult = await existingSession.exec('pwd');
                if (verifyResult.stdout.trim() !== cwd) {
                    // throw new Error(`Failed to set working directory to ${cwd}, currently at ${verifyResult.stdout.trim()}`);
                    this.logger.error(`Failed to set working directory to ${cwd}, currently at ${verifyResult.stdout.trim()}`);
                }
                this.logger.info('Successfully changed directory for existing session', { sessionId, cwd });
            }

            return existingSession;
        }
    }

    /**
     * Get or create a session for an instance with automatic caching.
     * Environment variables should be set via .dev.vars file.
     */
    private async getInstanceSession(instanceId: string, cwd?: string): Promise<ExecutionSession> {
        if (!this.sessionCache.has(instanceId)) {
            if (instanceId === 'sandbox-default') {
                cwd = '/workspace';
            } else {
                cwd = cwd || `/workspace/${instanceId}`;
            }
            const session = await this.getOrCreateSession(instanceId, cwd);
            this.sessionCache.set(instanceId, session);
        }
        const session = this.sessionCache.get(instanceId);
        return session!;
    }

    /**
     * Get or create default session for anonymous sandbox operations
     */
    private async getDefaultSession(): Promise<ExecutionSession> {
        return await this.getInstanceSession('sandbox-default', '/workspace');
    }

    private async executeCommand(instanceId: string, command: string, options?: { timeout?: number }): Promise<ExecResult> {
        const session = await this.getInstanceSession(instanceId);
        return await session.exec(command, options);
    }

    /**
     * Safe wrapper for direct sandbox exec calls using default session
     */
    private async safeSandboxExec(command: string, options?: { timeout?: number }): Promise<ExecResult> {
        const session = await this.getDefaultSession();
        return await session.exec(command, options);
    }

    /**
     * Invalidate session cache (call when instance is destroyed)
     */
    private invalidateSessionCache(instanceId: string): void {
        if (this.sessionCache.has(instanceId)) {
            this.sessionCache.delete(instanceId);
            this.logger.debug('Session cache invalidated', { instanceId });
        }
    }

    /** Write a binary file to the sandbox using small base64 chunks to avoid large control messages. */
    private async writeBinaryFileViaBase64(targetPath: string, data: ArrayBuffer, bytesPerChunk: number = 16 * 1024): Promise<void> {
        const dir = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '.';
        // Ensure directory and clean target file
        await this.safeSandboxExec(`mkdir -p '${dir}'`);
        await this.safeSandboxExec(`rm -f '${targetPath}'`);

        const buffer = new Uint8Array(data);
        for (let i = 0; i < buffer.length; i += bytesPerChunk) {
            const chunk = buffer.subarray(i, Math.min(i + bytesPerChunk, buffer.length));
            const base64Chunk = btoa(String.fromCharCode(...chunk));
            // Append decoded bytes into the target file inside the sandbox
            const appendResult = await this.safeSandboxExec(`printf '%s' '${base64Chunk}' | base64 -d >> '${targetPath}'`);
            if (appendResult.exitCode !== 0) {
                throw new Error(`Failed to append to ${targetPath}: ${appendResult.stderr}`);
            }
        }
    }

    /**
     * Write multiple files efficiently using a single shell script
     * Reduces 2N requests to just 2 requests regardless of file count
     * Uses base64 encoding to handle all content safely
     */
    private async writeFilesViaScript(
        files: Array<{ path: string, content: string }>,
        session: ExecutionSession
    ): Promise<Array<{ file: string, success: boolean, error?: string }>> {
        if (files.length === 0) return [];

        this.logger.info('Writing files via shell script', { fileCount: files.length });

        // Generate shell script
        const scriptLines = ['#!/bin/bash'];

        for (const { path, content } of files) {
            const utf8Bytes = new TextEncoder().encode(content);

            // Convert bytes to base64 in chunks to avoid stack overflow
            const chunkSize = 8192;
            const base64Chunks: string[] = [];

            for (let i = 0; i < utf8Bytes.length; i += chunkSize) {
                const chunk = utf8Bytes.slice(i, i + chunkSize);
                // Convert chunk to binary string
                let binaryString = '';
                for (let j = 0; j < chunk.length; j++) {
                    binaryString += String.fromCharCode(chunk[j]);
                }
                // Encode chunk to base64
                base64Chunks.push(btoa(binaryString));
            }

            const base64 = base64Chunks.join('');

            scriptLines.push(
                `mkdir -p "$(dirname "${path}")" && echo '${base64}' | base64 -d > "${path}" && echo "OK:${path}" || echo "FAIL:${path}"`
            );
        }

        const script = scriptLines.join('\n');
        const scriptPath = '/tmp/batch_write.sh';

        try {
            // Write script (1 request)
            const writeResult = await session.writeFile(scriptPath, script);
            if (!writeResult.success) {
                throw new Error('Failed to write batch script');
            }

            // Execute with bash
            const { stdout, stderr } = await session.exec(`bash ${scriptPath}`, { timeout: 60000 });

            // Parse results from output
            const output = stdout + stderr;
            const matches = output.matchAll(/OK:(.+)/g);
            const successPaths = new Set<string>();
            for (const match of matches) {
                if (match[1]) successPaths.add(match[1]);
            }

            const results = files.map(({ path }) => ({
                file: path,
                success: successPaths.has(path),
                error: successPaths.has(path) ? undefined : 'Write failed'
            }));

            const successCount = successPaths.size;
            const failedCount = files.length - successCount;

            if (failedCount > 0) {
                this.logger.warn('Batch write completed with errors', {
                    total: files.length,
                    success: successCount,
                    failed: failedCount
                });
            } else {
                this.logger.info('Batch write completed', {
                    total: files.length,
                    success: successCount
                });
            }

            return results;

        } catch (error) {
            this.logger.error('Batch write failed', error);
            return files.map(({ path }) => ({
                file: path,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }));
        }
    }

    async updateProjectName(instanceId: string, projectName: string): Promise<boolean> {
        try {
            await this.updateProjectConfiguration(instanceId, projectName);
            try {
                const metadata = await this.getInstanceMetadata(instanceId);
                const updated = { ...metadata, projectName } as InstanceMetadata;
                await this.storeInstanceMetadata(instanceId, updated);
            } catch (error) {
                this.logger.error('Failed to update instance metadata', error);
            }
            return true;
        } catch (error) {
            this.logger.error('Failed to update project name', error);
            return false;
        }
    }

    private getInstanceMetadataFile(instanceId: string): string {
        return `/workspace/${instanceId}-metadata.json`;
    }

    private async getInstanceMetadata(instanceId: string): Promise<InstanceMetadata> {
        // Check cache first
        if (this.metadataCache.has(instanceId)) {
            return this.metadataCache.get(instanceId)!;
        }

        // Cache miss - read from disk
        try {
            const session = await this.getDefaultSession();
            const metadataFile = await session.readFile(this.getInstanceMetadataFile(instanceId));
            if (!metadataFile.success) {
                throw new Error('Failed to read instance metadata file');
            }
            const metadata = JSON.parse(metadataFile.content) as InstanceMetadata;
            this.metadataCache.set(instanceId, metadata); // Cache it
            return metadata;
        } catch (error) {
            this.logger.error(`Failed to read instance metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw new Error(`Failed to read instance metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async storeInstanceMetadata(instanceId: string, metadata: InstanceMetadata): Promise<void> {
        const session = await this.getDefaultSession();
        const result = await session.writeFile(this.getInstanceMetadataFile(instanceId), JSON.stringify(metadata));
        if (!result.success) {
            throw new Error(`Failed to write instance metadata: ${result.path}`);
        }
        this.metadataCache.set(instanceId, metadata); // Update cache
    }

    private invalidateMetadataCache(instanceId: string): void {
        this.metadataCache.delete(instanceId);
    }

    private async allocateAvailablePort(excludedPorts: number[] = [3000]): Promise<number> {
        const startTime = Date.now();
        const excludeList = excludedPorts.join(' ');

        // Single command to find first available port in dev range (8001-8999)
        const findPortCmd = `
            for port in $(seq 8001 8999); do
                if ! echo "${excludeList}" | grep -q "\\\\b$port\\\\b" && 
                   ! netstat -tuln 2>/dev/null | grep -q ":$port " && 
                   ! ss -tuln 2>/dev/null | grep -q ":$port "; then
                    echo $port
                    break
                fi
            done
        `;

        const result = await this.safeSandboxExec(findPortCmd.trim());
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
        this.logger.info(`Port allocation took ${duration} seconds`);

        const portStr = result.stdout.trim();
        if (portStr) {
            const port = parseInt(portStr);
            this.logger.info(`Allocated available port: ${port}`);
            return port;
        }

        throw new Error('No available ports found in range 8001-8999');
    }

    private async checkTemplateExists(templateName: string): Promise<boolean> {
        // Single command to check if template directory and package.json both exist
        const checkResult = await this.safeSandboxExec(`test -f ${templateName}/package.json && echo "exists" || echo "missing"`);
        return checkResult.exitCode === 0 && checkResult.stdout.trim() === "exists";
    }

    async downloadTemplate(templateName: string, downloadDir?: string): Promise<ArrayBuffer> {
        // Fetch the zip file from R2
        const downloadUrl = downloadDir ? `${downloadDir}/${templateName}.zip` : `${templateName}.zip`;
        this.logger.info(`Fetching object: ${downloadUrl} from R2 bucket`);
        const r2Object = await env.TEMPLATES_BUCKET.get(downloadUrl);

        if (!r2Object) {
            throw new Error(`Object '${downloadUrl}' not found in bucket`);
        }

        const zipData = await r2Object.arrayBuffer();

        this.logger.info(`Downloaded zip file (${zipData.byteLength} bytes)`);
        return zipData;
    }

    private async ensureTemplateExists(templateName: string, downloadDir?: string, isInstance: boolean = false) {
        if (!await this.checkTemplateExists(templateName)) {
            // Download and extract template
            this.logger.info(`Template doesnt exist, Downloading template from: ${templateName}`);

            const zipData = await this.downloadTemplate(templateName, downloadDir);
            // Stream zip to sandbox in safe base64 chunks and write directly as binary
            await this.writeBinaryFileViaBase64(`${templateName}.zip`, zipData);
            this.logger.info(`Wrote zip file to sandbox in chunks: ${templateName}.zip`);

            const setupResult = await this.safeSandboxExec(`unzip -o -q ${templateName}.zip -d ${isInstance ? '.' : templateName}`);

            if (setupResult.exitCode !== 0) {
                throw new Error(`Failed to download/extract template: ${setupResult.stderr}`);
            }
        } else {
            this.logger.info(`Template already exists`);
        }
    }

    private async buildFileTree(instanceId: string): Promise<FileTreeNode | undefined> {
        try {
            // Generate find command with exclusions
            const { dirExclusions, fileExclusions } = FileTreeBuilder.generateFindExclusions();

            // Build the command dynamically
            const buildTreeCmd = `echo "===FILES==="; find . -type d \\( ${dirExclusions} \\) -prune -o \\( -type f ${fileExclusions} \\) -print; echo "===DIRS==="; find . -type d \\( ${dirExclusions} \\) -prune -o -type d -print`;

            const filesResult = await this.executeCommand(instanceId, buildTreeCmd);
            if (filesResult.exitCode === 0) {
                return FileTreeBuilder.buildFromFindOutput(filesResult.stdout.trim());
            }
        } catch (error) {
            this.logger.warn('Failed to build file tree', error);
        }
        return undefined;
    }

    // ==========================================
    // INSTANCE LIFECYCLE
    // ==========================================

    async listAllInstances(): Promise<ListInstancesResponse> {
        try {
            this.logger.info('Retrieving instance metadata');

            // Use a single command to find metadata files only in current directory (not nested)
            const bulkResult = await this.safeSandboxExec(`find . -maxdepth 1 -name "*-metadata.json" -type f -exec sh -c 'echo "===FILE:$1==="; cat "$1"' _ {} \\;`);

            if (bulkResult.exitCode !== 0) {
                return {
                    success: true,
                    instances: [],
                    count: 0
                };
            }

            const instances: InstanceDetails[] = [];

            // Parse the combined output
            const metadataSections: string[] = bulkResult.stdout.split('===FILE:').filter((section: string) => section.trim());

            for (const section of metadataSections) {
                try {
                    const lines = section.trim().split('\n');
                    if (lines.length < 2) continue;

                    // First line contains the file path, remaining lines contain the JSON
                    const filePath = lines[0].replace('===', '');
                    const jsonContent = lines.slice(1).join('\n');

                    // Extract instance ID from filename (remove ./ prefix and -metadata.json suffix)
                    const instanceId = filePath.replace('./', '').replace('-metadata.json', '');

                    // Parse metadata
                    const metadata = JSON.parse(jsonContent) as InstanceMetadata;

                    // Update cache with the metadata we just read
                    this.metadataCache.set(instanceId, metadata);

                    // Create lightweight instance details from metadata
                    const instanceDetails: InstanceDetails = {
                        runId: instanceId,
                        templateName: metadata.templateName,
                        startTime: new Date(metadata.startTime),
                        uptime: Math.floor((Date.now() - new Date(metadata.startTime).getTime()) / 1000),
                        directory: instanceId,
                        serviceDirectory: instanceId,
                        previewURL: metadata.previewURL,
                        processId: metadata.processId,
                        tunnelURL: metadata.tunnelURL,
                        // Skip file tree
                        fileTree: undefined,
                        runtimeErrors: undefined
                    };

                    instances.push(instanceDetails);
                } catch (error) {
                    this.logger.warn(`Failed to process metadata section`, error);
                }
            }

            this.logger.info('Instance list retrieved', { instanceCount: instances.length });

            return {
                success: true,
                instances,
                count: instances.length
            };
        } catch (error) {
            this.logger.error('listAllInstances', error);
            return {
                success: false,
                instances: [],
                count: 0,
                error: `Failed to list instances: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Waits for the development server to be ready by monitoring logs for readiness indicators
     */
    private async waitForServerReady(instanceId: string, processId: string, maxWaitTimeMs: number = 10000): Promise<boolean> {
        const startTime = Date.now();
        const pollIntervalMs = 500;
        const maxAttempts = Math.ceil(maxWaitTimeMs / pollIntervalMs);

        // Patterns that indicate the server is ready
        const readinessPatterns = [
            /http:\/\/[^\s]+/,           // Any HTTP URL (most reliable)
            /ready in \d+/i,             // Vite "ready in X ms"
            /Local:\s+http/i,            // Vite local server line
            /Network:\s+http/i,          // Vite network server line
            /server running/i,           // Generic server running message
            /listening on/i              // Generic listening message
        ];

        this.logger.info('Waiting for development server', { instanceId, processId, timeoutMs: maxWaitTimeMs });

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Get recent logs only to avoid processing old content
                const logsResult = await this.getLogs(instanceId, true);

                if (logsResult.success && logsResult.logs.stdout) {
                    const logs = logsResult.logs.stdout;

                    // Check for any readiness pattern
                    for (const pattern of readinessPatterns) {
                        if (pattern.test(logs)) {
                            const elapsedTime = Date.now() - startTime;
                            this.logger.info('Development server ready', { instanceId, elapsedTimeMs: elapsedTime, attempts: `${attempt}/${maxAttempts}` });
                            return true;
                        }
                    }
                }

                // Wait before next attempt (except on last attempt)
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                }

            } catch (error) {
                this.logger.warn(`Error checking server readiness for ${instanceId} (attempt ${attempt}):`, error);
                // Continue trying even if there's an error getting logs
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                }
            }
        }

        const elapsedTime = Date.now() - startTime;
        this.logger.warn('Development server readiness timeout', { instanceId, elapsedTimeMs: elapsedTime, totalAttempts: maxAttempts });
        return false;
    }

    private async startDevServer(instanceId: string, port: number): Promise<string> {
        const startTime = Date.now();
        this.logger.info('🚀 [START_DEV_SERVER] Starting development server', { instanceId, port });

        try {
            // Use session-based process management
            // Note: Environment variables should already be set via setLocalEnvVars
            this.logger.info('🔍 [START_DEV_SERVER] Getting or creating dev session', { instanceId });
            const session = await this.getOrCreateSession(`${instanceId}-dev`, `/workspace/${instanceId}`);
            this.logger.info('✅ [START_DEV_SERVER] Dev session obtained', { instanceId });

            // Check if package.json exists and has dev script
            this.logger.info('📦 [START_DEV_SERVER] Checking package.json for dev script', { instanceId });
            try {
                const packageJsonFile = await session.readFile(`/workspace/${instanceId}/package.json`);
                if (packageJsonFile.success) {
                    const packageJson = JSON.parse(packageJsonFile.content);
                    const devScript = packageJson.scripts?.dev;
                    this.logger.info('📦 [START_DEV_SERVER] Package.json found', {
                        instanceId,
                        hasDevScript: !!devScript,
                        devScript: devScript || 'NOT FOUND',
                        packageName: packageJson.name
                    });

                    if (!devScript) {
                        this.logger.error('❌ [START_DEV_SERVER] No dev script found in package.json!', {
                            instanceId,
                            availableScripts: Object.keys(packageJson.scripts || {})
                        });
                    }
                } else {
                    this.logger.error('❌ [START_DEV_SERVER] Failed to read package.json', { instanceId });
                }
            } catch (packageError) {
                this.logger.warn('⚠️ [START_DEV_SERVER] Error checking package.json', {
                    instanceId,
                    error: packageError instanceof Error ? packageError.message : 'Unknown error'
                });
            }

            // Modify package.json dev script to use PORT variable
            // The template's dev script uses concurrently with multiple vite commands
            // We need to inject --port ${PORT} into the first vite command
            let devScriptModified = false;
            try {
                const packageJsonFile = await session.readFile(`/workspace/${instanceId}/package.json`);
                if (packageJsonFile.success) {
                    const packageJson = JSON.parse(packageJsonFile.content);
                    const originalDevScript = packageJson.scripts?.dev;

                    if (originalDevScript) {
                        let modifiedDevScript = originalDevScript;

                        if (originalDevScript.includes('concurrently')) {
                            // Modify concurrently command to inject --port with actual port number into first vite command
                            // Pattern: "vite --host 0.0.0.0" -> "vite --host 0.0.0.0 --port 8001"
                            modifiedDevScript = originalDevScript.replace(
                                /("vite\s+--host\s+0\.0\.0\.0")/,
                                `"vite --host 0.0.0.0 --port ${port}"`
                            );

                            if (modifiedDevScript !== originalDevScript) {
                                packageJson.scripts.dev = modifiedDevScript;
                                const updatedContent = JSON.stringify(packageJson, null, 2);
                                const writeResult = await session.writeFile(`/workspace/${instanceId}/package.json`, updatedContent);

                                if (writeResult.success) {
                                    devScriptModified = true;
                                    this.logger.info('🔧 [START_DEV_SERVER] Modified dev script to use PORT', {
                                        instanceId,
                                        port,
                                        original: originalDevScript.substring(0, 150),
                                        modified: modifiedDevScript.substring(0, 150)
                                    });
                                } else {
                                    this.logger.warn('⚠️ [START_DEV_SERVER] Failed to write modified package.json', {
                                        instanceId,
                                        error: 'Write operation failed'
                                    });
                                }
                            }
                        } else if (originalDevScript.includes('vite')) {
                            // Single vite command - inject port directly
                            modifiedDevScript = originalDevScript.includes('--port')
                                ? originalDevScript.replace(/--port\s+\d+/, `--port ${port}`)
                                : originalDevScript.replace(/vite\s+/, `vite --port ${port} `);

                            if (modifiedDevScript !== originalDevScript) {
                                packageJson.scripts.dev = modifiedDevScript;
                                const updatedContent = JSON.stringify(packageJson, null, 2);
                                const writeResult = await session.writeFile(`/workspace/${instanceId}/package.json`, updatedContent);

                                if (writeResult.success) {
                                    devScriptModified = true;
                                    this.logger.info('🔧 [START_DEV_SERVER] Modified single vite dev script to use PORT', {
                                        instanceId,
                                        port,
                                        original: originalDevScript,
                                        modified: modifiedDevScript
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (modifyError) {
                this.logger.warn('⚠️ [START_DEV_SERVER] Failed to modify dev script, will use original', {
                    instanceId,
                    error: modifyError instanceof Error ? modifyError.message : 'Unknown error'
                });
            }

            // Start process with env vars inline for those not in .dev.vars
            // PORT is set as env var, and package.json now uses ${PORT} which will be expanded by shell
            const command = `VITE_LOGGER_TYPE=json PORT=${port} monitor-cli process start --instance-id ${instanceId} --port ${port} -- bun run dev`;
            this.logger.info('▶️ [START_DEV_SERVER] Starting process', {
                instanceId,
                port,
                devScriptModified,
                command: command.substring(0, 250) + '...'
            });

            const processStartTime = Date.now();
            const process = await session.startProcess(command);
            const processStartDuration = Date.now() - processStartTime;

            this.logger.info('✅ [START_DEV_SERVER] Process started', {
                instanceId,
                processId: process.id,
                durationMs: processStartDuration
            });

            // Wait for the server to be ready (non-blocking - always returns the process ID)
            this.logger.info('⏳ [START_DEV_SERVER] Waiting for server readiness', {
                instanceId,
                processId: process.id,
                timeoutMs: 10000
            });

            try {
                const readinessStartTime = Date.now();
                const isReady = await this.waitForServerReady(instanceId, process.id, 10000);
                const readinessDuration = Date.now() - readinessStartTime;

                if (isReady) {
                    this.logger.info('✅ [START_DEV_SERVER] Development server is ready', {
                        instanceId,
                        processId: process.id,
                        readinessDurationMs: readinessDuration
                    });
                } else {
                    this.logger.warn('⚠️ [START_DEV_SERVER] Development server may not be fully ready', {
                        instanceId,
                        processId: process.id,
                        readinessDurationMs: readinessDuration
                    });

                    // Get logs to see what happened
                    try {
                        const logsResult = await this.getLogs(instanceId, false);
                        if (logsResult.success && logsResult.logs) {
                            const recentLogs = logsResult.logs.stdout?.split('\n').slice(-10).join('\n') || '';
                            this.logger.warn('📋 [START_DEV_SERVER] Recent logs (server not ready)', {
                                instanceId,
                                recentLogs: recentLogs.substring(0, 500)
                            });
                        }
                    } catch (logsError) {
                        this.logger.warn('⚠️ [START_DEV_SERVER] Could not get logs', {
                            instanceId,
                            error: logsError instanceof Error ? logsError.message : 'Unknown error'
                        });
                    }
                }
            } catch (readinessError) {
                this.logger.warn(`⚠️ [START_DEV_SERVER] Error during readiness check for ${instanceId}:`, {
                    instanceId,
                    processId: process.id,
                    error: readinessError instanceof Error ? readinessError.message : 'Unknown error',
                    errorStack: readinessError instanceof Error ? readinessError.stack : undefined
                });
                this.logger.info('⏭️ [START_DEV_SERVER] Continuing with server startup despite readiness check error', { instanceId });
            }

            const totalDuration = Date.now() - startTime;
            this.logger.info('🎉 [START_DEV_SERVER] Dev server startup completed', {
                instanceId,
                processId: process.id,
                port,
                totalDurationMs: totalDuration
            });

            return process.id;
        } catch (error) {
            const totalDuration = Date.now() - startTime;
            this.logger.error('❌ [START_DEV_SERVER] Failed to start dev server', {
                instanceId,
                port,
                totalDurationMs: totalDuration,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }
    }

    /**
     * Provisions Cloudflare resources for template placeholders in wrangler.jsonc
     */
    private async provisionTemplateResources(instanceId: string, projectName: string): Promise<ResourceProvisioningResult> {
        try {
            const session = await this.getInstanceSession(instanceId);

            // Read wrangler.jsonc file using absolute path
            const wranglerFile = await session.readFile(`/workspace/${instanceId}/wrangler.jsonc`);
            if (!wranglerFile.success) {
                this.logger.info(`No wrangler.jsonc found for ${instanceId}, skipping resource provisioning`);
                return {
                    success: true,
                    provisioned: [],
                    failed: [],
                    replacements: {},
                    wranglerUpdated: false
                };
            }

            // Parse and detect placeholders
            const templateParser = new TemplateParser(this.logger);
            const parseResult = templateParser.parseWranglerConfig(wranglerFile.content);

            if (!parseResult.hasPlaceholders) {
                this.logger.info('No placeholders found in wrangler configuration', { instanceId });
                return {
                    success: true,
                    provisioned: [],
                    failed: [],
                    replacements: {},
                    wranglerUpdated: false
                };
            }

            this.logger.info('Placeholders found for provisioning', { instanceId, count: parseResult.placeholders.length });

            // Initialize resource provisioner (skip if credentials are not available)
            let resourceProvisioner: ResourceProvisioner;
            try {
                resourceProvisioner = new ResourceProvisioner(this.logger);
            } catch (error) {
                this.logger.warn(`Cannot initialize resource provisioner: ${error instanceof Error ? error.message : 'Unknown error'}`);
                return {
                    success: true,
                    provisioned: [],
                    failed: parseResult.placeholders.map(p => ({
                        placeholder: p.placeholder,
                        resourceType: p.resourceType,
                        error: 'Missing Cloudflare credentials',
                        binding: p.binding
                    })),
                    replacements: {},
                    wranglerUpdated: false
                };
            }

            const provisioned: ResourceProvisioningResult['provisioned'] = [];
            const failed: ResourceProvisioningResult['failed'] = [];
            const replacements: Record<string, string> = {};

            // Provision each resource
            for (const placeholderInfo of parseResult.placeholders) {
                this.logger.info(`Provisioning ${placeholderInfo.resourceType} resource for placeholder ${placeholderInfo.placeholder}`);

                const provisionResult = await resourceProvisioner.provisionResource(
                    placeholderInfo.resourceType,
                    projectName
                );

                if (provisionResult.success && provisionResult.resourceId) {
                    provisioned.push({
                        placeholder: placeholderInfo.placeholder,
                        resourceType: placeholderInfo.resourceType,
                        resourceId: provisionResult.resourceId,
                        binding: placeholderInfo.binding
                    });
                    replacements[placeholderInfo.placeholder] = provisionResult.resourceId;
                } else {
                    failed.push({
                        placeholder: placeholderInfo.placeholder,
                        resourceType: placeholderInfo.resourceType,
                        error: provisionResult.error || 'Unknown error',
                        binding: placeholderInfo.binding
                    });
                    this.logger.warn(`Failed to provision ${placeholderInfo.resourceType} for ${placeholderInfo.placeholder}: ${provisionResult.error}`);
                }
            }

            // Update wrangler.jsonc if we have replacements
            let wranglerUpdated = false;
            if (Object.keys(replacements).length > 0) {
                const updatedContent = templateParser.replacePlaceholders(wranglerFile.content, replacements);
                const writeResult = await session.writeFile(`/workspace/${instanceId}/wrangler.jsonc`, updatedContent);

                if (writeResult.success) {
                    wranglerUpdated = true;
                    this.logger.info(`Updated wrangler.jsonc with ${Object.keys(replacements).length} resource IDs for ${instanceId}`);
                    this.logger.info(templateParser.createReplacementSummary(replacements));
                } else {
                    this.logger.error(`Failed to update wrangler.jsonc for ${instanceId}`);
                }
            }

            const result: ResourceProvisioningResult = {
                success: failed.length === 0,
                provisioned,
                failed,
                replacements,
                wranglerUpdated
            };

            if (failed.length > 0) {
                this.logger.warn(`Resource provisioning completed with ${failed.length} failures for ${instanceId}`);
            } else {
                this.logger.info(`Resource provisioning completed successfully for ${instanceId}`);
            }

            return result;
        } catch (error) {
            this.logger.error(`Exception during resource provisioning for ${instanceId}:`, error);
            return {
                success: false,
                provisioned: [],
                failed: [],
                replacements: {},
                wranglerUpdated: false
            };
        }
    }

    /*
    * Starts a cloudflared tunnel for the specified instance
    * Super usefulfor local development
    */
    private async startCloudflaredTunnel(instanceId: string, port: number): Promise<string> {
        try {
            const session = await this.getOrCreateSession(`${instanceId}-tunnel`, `/workspace/${instanceId}`);
            const process = await session.startProcess(
                `cloudflared tunnel --url http://localhost:${port}`
            );
            this.logger.info(`Started cloudflared tunnel for ${instanceId}`);

            // Stream process logs to extract the preview URL
            const logStream = await this.getSandbox().streamProcessLogs(process.id);

            return new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    // reject(new Error('Timeout waiting for cloudflared tunnel URL'));
                    this.logger.warn('Timeout waiting for cloudflared tunnel URL');
                    resolve('');
                }, 20000); // 20 second timeout

                const processLogs = async () => {
                    try {
                        for await (const event of parseSSEStream<LogEvent>(logStream)) {
                            if (event.data) {
                                const logLine = event.data;
                                this.logger.info(`Cloudflared log ===> ${logLine}`);

                                // Look for the preview URL in the logs
                                // Format: https://subdomain.trycloudflare.com
                                const urlMatch = logLine.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
                                if (urlMatch) {
                                    clearTimeout(timeout);
                                    const previewURL = urlMatch[0];
                                    this.logger.info(`Found cloudflared tunnel URL: ${previewURL}`);
                                    resolve(previewURL);
                                    return;
                                }
                            }
                        }
                    } catch (error) {
                        this.logger.error('Cloudflare tunnel process failed', error);
                        clearTimeout(timeout);
                        reject(error);
                    }
                };

                processLogs();
            });
        } catch (error) {
            this.logger.warn('Failed to start cloudflared tunnel', error);
            throw error;
        }
    }

    /**
     * Updates project configuration files with the specified project name
     */
    private async updateProjectConfiguration(instanceId: string, projectName: string): Promise<void> {
        try {
            const session = await this.getInstanceSession(instanceId);

            // Update package.json with new project name (top-level only)
            this.logger.info(`Updating package.json with project name: ${projectName}`);
            const packageJsonResult = await session.exec(`sed -i '1,10s/^[ \t]*"name"[ ]*:[ ]*"[^"]*"/  "name": "${projectName}"/' package.json`);

            if (packageJsonResult.exitCode !== 0) {
                this.logger.warn('Failed to update package.json', packageJsonResult.stderr);
            }

            // Update wrangler.jsonc with new project name (top-level only)
            this.logger.info(`Updating wrangler.jsonc with project name: ${projectName}`);
            const wranglerResult = await session.exec(`sed -i '0,/"name":/s/"name"[ ]*:[ ]*"[^"]*"/"name": "${projectName}"/' wrangler.jsonc`);

            if (wranglerResult.exitCode !== 0) {
                this.logger.warn('Failed to update wrangler.jsonc', wranglerResult.stderr);
            }

            this.logger.info('Project configuration updated successfully');
        } catch (error) {
            this.logger.error(`Error updating project configuration: ${error}`);
            throw error;
        }
    }

    private async setLocalEnvVars(instanceId: string, localEnvVars: Record<string, string>): Promise<void> {
        try {
            // Write .dev.vars file - tools will read environment variables from this file
            const session = await this.getInstanceSession(instanceId);
            const envVarsContent = Object.entries(localEnvVars)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n');
            const result = await session.writeFile(`/workspace/${instanceId}/.dev.vars`, envVarsContent);
            if (!result.success) {
                throw new Error('Failed to write .dev.vars file');
            }
            this.logger.info('Environment variables written to .dev.vars', { instanceId, varCount: Object.keys(localEnvVars).length });
        } catch (error) {
            this.logger.error(`Error setting local environment variables: ${error}`);
            throw error;
        }
    }


    private async setupInstance(instanceId: string, projectName: string, localEnvVars?: Record<string, string>): Promise<{ previewURL: string, tunnelURL: string, processId: string, allocatedPort: number } | undefined> {
        const setupStartTime = Date.now();
        this.logger.info('⚙️ [SETUP_INSTANCE] Starting instance setup', {
            instanceId,
            projectName,
            hasLocalEnvVars: !!localEnvVars && Object.keys(localEnvVars).length > 0
        });

        try {
            const sandbox = this.getSandbox();

            // Update project configuration with the specified project name
            this.logger.info('📝 [SETUP_INSTANCE] Step 1: Updating project configuration', { instanceId, projectName });
            const configStartTime = Date.now();
            await this.updateProjectConfiguration(instanceId, projectName);
            const configDuration = Date.now() - configStartTime;
            this.logger.info('✅ [SETUP_INSTANCE] Project configuration updated', { instanceId, durationMs: configDuration });

            // Provision Cloudflare resources if template has placeholders
            this.logger.info('☁️ [SETUP_INSTANCE] Step 2: Provisioning Cloudflare resources', { instanceId, projectName });
            const provisionStartTime = Date.now();
            const resourceProvisioningResult = await this.provisionTemplateResources(instanceId, projectName);
            const provisionDuration = Date.now() - provisionStartTime;
            this.logger.info('📊 [SETUP_INSTANCE] Resource provisioning completed', {
                instanceId,
                durationMs: provisionDuration,
                success: resourceProvisioningResult.success,
                provisionedCount: resourceProvisioningResult.provisioned.length,
                failedCount: resourceProvisioningResult.failed.length,
                wranglerUpdated: resourceProvisioningResult.wranglerUpdated
            });
            if (!resourceProvisioningResult.success && resourceProvisioningResult.failed.length > 0) {
                this.logger.warn(`⚠️ [SETUP_INSTANCE] Some resources failed to provision for ${instanceId}, but continuing setup process`, {
                    failedResources: resourceProvisioningResult.failed
                });
            }

            // Store wrangler.jsonc configuration in KV after resource provisioning
            // Also inject platform secrets for admin dashboard authentication
            this.logger.info('💾 [SETUP_INSTANCE] Step 3: Storing wrangler config in KV', { instanceId });
            try {
                const session = await this.getInstanceSession(instanceId);
                const wranglerConfigFile = await session.readFile(`/workspace/${instanceId}/wrangler.jsonc`);
                if (wranglerConfigFile.success) {
                    // Inject platform JWT secret and admin dashboard URL for seamless admin auth
                    let configContent = wranglerConfigFile.content;
                    try {
                        // Parse JSONC (strip comments) and inject platform vars
                        const configWithoutComments = configContent
                            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
                            .replace(/\/\/.*$/gm, '');        // Remove line comments
                        const config = JSON.parse(configWithoutComments);

                        // Add platform auth vars to enable admin dashboard authentication
                        if (!config.vars) {
                            config.vars = {};
                        }

                        // Inject JWT_SECRET so stores can validate platform-issued JWTs
                        if ('JWT_SECRET' in env) {
                            config.vars.PLATFORM_JWT_SECRET = env.JWT_SECRET;
                            this.logger.info('🔐 [SETUP_INSTANCE] Injected PLATFORM_JWT_SECRET for admin dashboard auth', { instanceId });
                        }

                        // Inject admin dashboard URL for CORS
                        if ('CUSTOM_DOMAIN' in env) {
                            const protocol = (env.CUSTOM_DOMAIN as string).includes('localhost') ? 'http' : 'https';
                            config.vars.ADMIN_DASHBOARD_URL = `${protocol}://${env.CUSTOM_DOMAIN}`;
                            this.logger.info('🌐 [SETUP_INSTANCE] Injected ADMIN_DASHBOARD_URL for CORS', {
                                instanceId,
                                url: config.vars.ADMIN_DASHBOARD_URL
                            });
                        }

                        // Convert back to JSON (comments are stripped but that's fine for KV storage)
                        configContent = JSON.stringify(config, null, 2);
                    } catch (parseError) {
                        this.logger.warn('⚠️ [SETUP_INSTANCE] Could not parse wrangler config for injection, using original', {
                            instanceId,
                            error: parseError instanceof Error ? parseError.message : 'Unknown error'
                        });
                    }

                    await env.VibecoderStore.put(this.getWranglerKVKey(instanceId), configContent);
                    this.logger.info('✅ [SETUP_INSTANCE] Wrangler configuration stored in KV', { instanceId });
                } else {
                    this.logger.warn('⚠️ [SETUP_INSTANCE] Could not read wrangler.jsonc for KV storage', { instanceId });
                }
            } catch (error) {
                this.logger.warn('⚠️ [SETUP_INSTANCE] Failed to store wrangler config in KV (non-blocking)', {
                    instanceId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
                // Non-blocking - continue with setup
            }

            // Allocate single port for both dev server and tunnel
            this.logger.info('🔌 [SETUP_INSTANCE] Step 4: Allocating port', { instanceId });
            const portStartTime = Date.now();
            const allocatedPort = await this.allocateAvailablePort();
            const portDuration = Date.now() - portStartTime;
            this.logger.info('✅ [SETUP_INSTANCE] Port allocated', { instanceId, port: allocatedPort, durationMs: portDuration });

            this.logger.info('📦 [SETUP_INSTANCE] Step 5: Installing dependencies', { instanceId });
            const installStartTime = Date.now();
            const installResult = await this.executeCommand(instanceId, `bun install`, { timeout: 40000 });
            const installDuration = Date.now() - installStartTime;
            this.logger.info('📊 [SETUP_INSTANCE] Dependency installation completed', {
                instanceId,
                durationMs: installDuration,
                exitCode: installResult.exitCode,
                success: installResult.exitCode === 0,
                hasStderr: !!installResult.stderr,
                stderrPreview: installResult.stderr?.substring(0, 200)
            });

            if (installResult.exitCode === 0) {
                // Try to start development server in background
                try {
                    if (localEnvVars) {
                        this.logger.info('🔐 [SETUP_INSTANCE] Step 6: Setting local environment variables', {
                            instanceId,
                            varCount: Object.keys(localEnvVars).length
                        });
                        await this.setLocalEnvVars(instanceId, localEnvVars);
                        this.logger.info('✅ [SETUP_INSTANCE] Environment variables set', { instanceId });
                    }

                    // Start dev server on allocated port
                    // startDevServer already waits for server readiness internally
                    this.logger.info('🚀 [SETUP_INSTANCE] Step 7: Starting dev server', { instanceId, port: allocatedPort });
                    const devServerStartTime = Date.now();
                    const processId = await this.startDevServer(instanceId, allocatedPort);
                    const devServerDuration = Date.now() - devServerStartTime;
                    this.logger.info('✅ [SETUP_INSTANCE] Dev server started', {
                        instanceId,
                        processId,
                        port: allocatedPort,
                        durationMs: devServerDuration
                    });

                    // Verify process is actually running
                    this.logger.info('🔍 [SETUP_INSTANCE] Verifying dev server process is running', { instanceId, processId });
                    try {
                        const processes = await this.getSandbox().listProcesses();
                        const process = processes.find((p: { id: string; status: string }) => p.id === processId);
                        this.logger.info('📊 [SETUP_INSTANCE] Process status check', {
                            instanceId,
                            processId,
                            found: !!process,
                            status: process?.status,
                            allProcesses: processes.length
                        });

                        if (!process || process.status !== 'running') {
                            this.logger.error('❌ [SETUP_INSTANCE] Dev server process is not running!', {
                                instanceId,
                                processId,
                                processStatus: process?.status,
                                expectedStatus: 'running'
                            });
                        }
                    } catch (processError) {
                        this.logger.error('❌ [SETUP_INSTANCE] Failed to check process status', {
                            instanceId,
                            processId,
                            error: processError instanceof Error ? processError.message : 'Unknown error'
                        });
                    }

                    // Check server logs for errors and port information
                    this.logger.info('📋 [SETUP_INSTANCE] Checking dev server logs', { instanceId, processId });
                    try {
                        // Wait a bit for logs to accumulate
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const logsResult = await this.getLogs(instanceId, false);
                        if (logsResult.success && logsResult.logs) {
                            const stdoutLines = logsResult.logs.stdout?.split('\n') || [];
                            const stderrLines = logsResult.logs.stderr?.split('\n') || [];
                            const recentLogs = stdoutLines.slice(-30).join('\n') || '';
                            const recentErrors = stderrLines.slice(-30).join('\n') || '';

                            this.logger.info('📋 [SETUP_INSTANCE] Recent server logs (last 30 lines)', {
                                instanceId,
                                stdoutLineCount: stdoutLines.length,
                                stderrLineCount: stderrLines.length,
                                recentStdout: recentLogs.substring(0, 2000),
                                recentStderr: recentErrors.substring(0, 2000),
                                fullStdoutLength: logsResult.logs.stdout?.length || 0,
                                fullStderrLength: logsResult.logs.stderr?.length || 0
                            });

                            // Check for port information in logs
                            const portMatches = [
                                ...(recentLogs.match(/:\d{4,5}/g) || []),
                                ...(recentErrors.match(/:\d{4,5}/g) || [])
                            ];
                            if (portMatches.length > 0) {
                                this.logger.info('🔍 [SETUP_INSTANCE] Found port references in logs', {
                                    instanceId,
                                    ports: [...new Set(portMatches)].slice(0, 10),
                                    expectedPort: allocatedPort
                                });
                            }

                            // Check for vite server URLs
                            const viteUrlMatches = [
                                ...(recentLogs.match(/http:\/\/[^\s]+/g) || []),
                                ...(recentLogs.match(/Local:\s+http[^\s]+/gi) || []),
                                ...(recentLogs.match(/Network:\s+http[^\s]+/gi) || [])
                            ];
                            if (viteUrlMatches.length > 0) {
                                this.logger.info('🌐 [SETUP_INSTANCE] Found Vite server URLs in logs', {
                                    instanceId,
                                    urls: viteUrlMatches.slice(0, 5)
                                });
                            }

                            if (recentErrors) {
                                this.logger.warn('⚠️ [SETUP_INSTANCE] Server has stderr output', {
                                    instanceId,
                                    stderrPreview: recentErrors.substring(0, 1000)
                                });
                            }

                            if (stdoutLines.length === 0 && stderrLines.length === 0) {
                                this.logger.warn('⚠️ [SETUP_INSTANCE] No logs available yet - server may still be starting', {
                                    instanceId,
                                    processId
                                });
                            }
                        } else {
                            this.logger.warn('⚠️ [SETUP_INSTANCE] Failed to get logs or logs are empty', {
                                instanceId,
                                success: logsResult.success,
                                error: logsResult.error
                            });
                        }
                    } catch (logsError) {
                        this.logger.warn('⚠️ [SETUP_INSTANCE] Failed to get server logs', {
                            instanceId,
                            error: logsError instanceof Error ? logsError.message : 'Unknown error'
                        });
                    }

                    // Check if port is listening and also check what ports ARE listening
                    this.logger.info('🔌 [SETUP_INSTANCE] Checking if port is listening', { instanceId, port: allocatedPort });
                    try {
                        const session = await this.getInstanceSession(instanceId);

                        // Check specific port
                        const portCheckResult = await session.exec(`netstat -tuln 2>/dev/null | grep :${allocatedPort} || ss -tuln 2>/dev/null | grep :${allocatedPort} || echo "Port ${allocatedPort} not found"`);

                        // Also check what ports ARE listening (to see what vite actually started on)
                        const allPortsResult = await session.exec(`netstat -tuln 2>/dev/null | grep LISTEN | awk '{print $4}' | sed 's/.*://' | sort -n | head -10 || ss -tuln 2>/dev/null | grep LISTEN | awk '{print $5}' | sed 's/.*://' | sort -n | head -10 || echo "Could not list ports"`);

                        this.logger.info('🔌 [SETUP_INSTANCE] Port listening check', {
                            instanceId,
                            port: allocatedPort,
                            exitCode: portCheckResult.exitCode,
                            stdout: portCheckResult.stdout,
                            stderr: portCheckResult.stderr,
                            isListening: portCheckResult.stdout.includes(`:${allocatedPort}`),
                            listeningPorts: allPortsResult.stdout.split('\n').filter(p => p.trim()).slice(0, 10)
                        });

                        if (!portCheckResult.stdout.includes(`:${allocatedPort}`)) {
                            this.logger.warn('⚠️ [SETUP_INSTANCE] Expected port not listening, but other ports may be active', {
                                instanceId,
                                expectedPort: allocatedPort,
                                actualListeningPorts: allPortsResult.stdout.split('\n').filter(p => p.trim())
                            });
                        }
                    } catch (portError) {
                        this.logger.warn('⚠️ [SETUP_INSTANCE] Failed to check port status', {
                            instanceId,
                            port: allocatedPort,
                            error: portError instanceof Error ? portError.message : 'Unknown error'
                        });
                    }

                    // Add a small delay to ensure server is fully listening before starting tunnel
                    // This prevents 502 Bad Gateway errors from cloudflared trying to connect before the server is up
                    this.logger.info('⏳ [SETUP_INSTANCE] Waiting for server to be fully ready', { instanceId });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    this.logger.info('✅ [SETUP_INSTANCE] Server ready check completed', { instanceId });

                    // Start cloudflared tunnel AFTER dev server is ready
                    let tunnelURL = '';
                    if (isDev(env) || env.USE_TUNNEL_FOR_PREVIEW) {
                        this.logger.info('🌐 [SETUP_INSTANCE] Step 8: Starting cloudflared tunnel', { instanceId, port: allocatedPort });
                        const tunnelStartTime = Date.now();
                        try {
                            tunnelURL = await this.startCloudflaredTunnel(instanceId, allocatedPort);
                            const tunnelDuration = Date.now() - tunnelStartTime;
                            this.logger.info('✅ [SETUP_INSTANCE] Cloudflared tunnel started', {
                                instanceId,
                                tunnelURL,
                                durationMs: tunnelDuration
                            });
                        } catch (tunnelError) {
                            this.logger.warn('⚠️ [SETUP_INSTANCE] Failed to start cloudflared tunnel, continuing without tunnel', {
                                instanceId,
                                error: tunnelError instanceof Error ? tunnelError.message : 'Unknown error'
                            });
                        }
                    } else {
                        this.logger.info('⏭️ [SETUP_INSTANCE] Skipping tunnel (not in dev mode or not configured)', { instanceId });
                    }

                    // Expose the same port for preview URL
                    this.logger.info('🌍 [SETUP_INSTANCE] Step 9: Exposing port for preview URL', {
                        instanceId,
                        port: allocatedPort,
                        previewDomain: getPreviewDomain(env)
                    });
                    const exposeStartTime = Date.now();
                    const previewResult = await sandbox.exposePort(allocatedPort, { hostname: getPreviewDomain(env) });
                    let previewURL = previewResult.url;
                    if (!isDev(env)) {
                        const previewDomain = getPreviewDomain(env);
                        if (previewDomain) {
                            // Replace CUSTOM_DOMAIN with previewDomain in previewURL
                            previewURL = previewURL.replace(env.CUSTOM_DOMAIN, previewDomain);
                            this.logger.info('🔄 [SETUP_INSTANCE] Replaced domain in preview URL', {
                                original: previewResult.url,
                                replaced: previewURL,
                                previewDomain
                            });
                        }
                    }
                    const exposeDuration = Date.now() - exposeStartTime;
                    this.logger.info('✅ [SETUP_INSTANCE] Port exposed', {
                        instanceId,
                        durationMs: exposeDuration,
                        originalURL: previewResult.url,
                        finalPreviewURL: previewURL
                    });

                    if (env.USE_TUNNEL_FOR_PREVIEW && tunnelURL) {
                        this.logger.info('🔄 [SETUP_INSTANCE] Using tunnel URL for preview (configured)', {
                            instanceId,
                            tunnelURL,
                            originalPreviewURL: previewURL
                        });
                        previewURL = tunnelURL;
                    }

                    // Final health check before returning
                    this.logger.info('🏥 [SETUP_INSTANCE] Performing final health check', { instanceId, processId });
                    try {
                        const processes = await this.getSandbox().listProcesses();
                        const finalProcess = processes.find((p: { id: string; status: string }) => p.id === processId);
                        const isProcessRunning = !!(finalProcess && finalProcess.status === 'running');

                        this.logger.info('🏥 [SETUP_INSTANCE] Final health check results', {
                            instanceId,
                            processId,
                            isProcessRunning,
                            processStatus: finalProcess?.status,
                            previewURL,
                            tunnelURL,
                            allocatedPort
                        });

                        if (!isProcessRunning) {
                            this.logger.error('❌ [SETUP_INSTANCE] WARNING: Process is not running after setup!', {
                                instanceId,
                                processId,
                                processStatus: finalProcess?.status,
                                previewURL
                            });
                        }
                    } catch (healthError) {
                        this.logger.warn('⚠️ [SETUP_INSTANCE] Final health check failed', {
                            instanceId,
                            processId,
                            error: healthError instanceof Error ? healthError.message : 'Unknown error'
                        });
                    }

                    const totalDuration = Date.now() - setupStartTime;
                    this.logger.info('🎉 [SETUP_INSTANCE] Instance setup completed successfully', {
                        instanceId,
                        totalDurationMs: totalDuration,
                        previewURL,
                        tunnelURL,
                        processId,
                        allocatedPort,
                        hasPreviewURL: !!previewURL,
                        hasTunnelURL: !!tunnelURL
                    });

                    return { previewURL, tunnelURL, processId, allocatedPort };
                } catch (error) {
                    const totalDuration = Date.now() - setupStartTime;
                    this.logger.error('❌ [SETUP_INSTANCE] Failed to start dev server', {
                        instanceId,
                        totalDurationMs: totalDuration,
                        error: error instanceof Error ? error.message : 'Unknown error',
                        errorStack: error instanceof Error ? error.stack : undefined
                    });
                    return undefined;
                }
            } else {
                this.logger.error('❌ [SETUP_INSTANCE] Failed to install dependencies', {
                    instanceId,
                    exitCode: installResult.exitCode,
                    stderr: installResult.stderr,
                    stdout: installResult.stdout
                });
            }
        } catch (error) {
            const totalDuration = Date.now() - setupStartTime;
            this.logger.error('❌ [SETUP_INSTANCE] Failed to setup instance', {
                instanceId,
                totalDurationMs: totalDuration,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            });
        }

        return undefined;
    }

    private async fetchDontTouchFiles(templateName: string): Promise<string[]> {
        let donttouchFiles: string[] = [];
        try {
            // Read .donttouch_files.json using default session with full path
            const session = await this.getDefaultSession();
            const donttouchFile = await session.readFile(`${templateName}/.donttouch_files.json`);
            if (!donttouchFile.success) {
                this.logger.warn('Failed to read .donttouch_files.json');
                return donttouchFiles;
            }
            donttouchFiles = JSON.parse(donttouchFile.content) as string[];
        } catch (error) {
            this.logger.warn(`Failed to read .donttouch_files.json: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        return donttouchFiles;
    }

    private async fetchRedactedFiles(templateName: string): Promise<string[]> {
        let redactedFiles: string[] = [];
        try {
            // Read .redacted_files.json using default session with full path
            const session = await this.getDefaultSession();
            const redactedFile = await session.readFile(`${templateName}/.redacted_files.json`);
            if (!redactedFile.success) {
                this.logger.warn('Failed to read .redacted_files.json');
                return redactedFiles;
            }
            redactedFiles = JSON.parse(redactedFile.content) as string[];
        } catch (error) {
            this.logger.warn(`Failed to read .redacted_files.json: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        return redactedFiles;
    }

    async createInstance(templateName: string, projectName: string, webhookUrl?: string, localEnvVars?: Record<string, string>): Promise<BootstrapResponse> {
        const createStartTime = Date.now();
        this.logger.info('🏗️ [CREATE_INSTANCE] Starting instance creation', {
            templateName,
            projectName,
            webhookUrl,
            hasLocalEnvVars: !!localEnvVars && Object.keys(localEnvVars).length > 0,
            envVarKeys: localEnvVars ? Object.keys(localEnvVars) : []
        });

        try {
            // Environment variables will be set via session creation on first use
            if (localEnvVars && Object.keys(localEnvVars).length > 0) {
                this.logger.info('Environment variables will be configured via session', { envVars: Object.keys(localEnvVars) });
            }
            let instanceId: string;
            if (env.ALLOCATION_STRATEGY === 'one_to_one') {
                // Multiple instances shouldn't exist in the same sandbox

                // If there are already instances running in sandbox, log them
                const instancesResp = await this.listAllInstances();
                if (instancesResp.success && instancesResp.instances.length > 0) {
                    this.logger.error('There are already instances running in sandbox, creating a new instance may cause issues', { instances: instancesResp.instances });
                    // Try to see if this instance actually exists and if the process is active
                    const firstInstance = instancesResp.instances[0];
                    const instanceStatus = await this.getInstanceStatus(firstInstance.runId);
                    if (instanceStatus.success && instanceStatus.isHealthy) {
                        this.logger.error('Instance already exists and is active, creating a new instance may cause issues', { instance: firstInstance });
                        // Return instance information
                        return {
                            success: true,
                            runId: firstInstance.runId,
                            previewURL: instanceStatus.previewURL,
                            tunnelURL: instanceStatus.tunnelURL,
                            processId: instanceStatus.processId,
                            message: instanceStatus.message
                        };
                    } else {
                        this.logger.error('Instance already exists but is not active, Removing old instance', { instance: firstInstance });
                        await this.shutdownInstance(firstInstance.runId);
                    }
                }

                instanceId = `i-${this.sandboxId}`;
            } else {
                instanceId = `i-${generateId()}`;
            }
            this.logger.info('🏗️ [CREATE_INSTANCE] Creating sandbox instance', { instanceId, templateName, projectName });

            let results: { previewURL: string, tunnelURL: string, processId: string, allocatedPort: number } | undefined;

            this.logger.info('📦 [CREATE_INSTANCE] Step 1: Ensuring template exists', { templateName });
            const templateStartTime = Date.now();
            await this.ensureTemplateExists(templateName);
            const templateDuration = Date.now() - templateStartTime;
            this.logger.info('✅ [CREATE_INSTANCE] Template ensured', { templateName, durationMs: templateDuration });

            this.logger.info('📋 [CREATE_INSTANCE] Step 2: Fetching donttouch and redacted files', { templateName });
            const fetchStartTime = Date.now();
            const [donttouchFiles, redactedFiles] = await Promise.all([
                this.fetchDontTouchFiles(templateName),
                this.fetchRedactedFiles(templateName)
            ]);
            const fetchDuration = Date.now() - fetchStartTime;
            this.logger.info('✅ [CREATE_INSTANCE] Files fetched', {
                donttouchFilesCount: donttouchFiles.length,
                redactedFilesCount: redactedFiles.length,
                durationMs: fetchDuration
            });

            this.logger.info('📁 [CREATE_INSTANCE] Step 3: Moving template to instance directory', {
                from: templateName,
                to: instanceId
            });
            const moveStartTime = Date.now();
            const moveTemplateResult = await this.safeSandboxExec(`mv ${templateName} ${instanceId}`);
            const moveDuration = Date.now() - moveStartTime;
            if (moveTemplateResult.exitCode !== 0) {
                this.logger.error('❌ [CREATE_INSTANCE] Failed to move template', {
                    exitCode: moveTemplateResult.exitCode,
                    stderr: moveTemplateResult.stderr,
                    stdout: moveTemplateResult.stdout
                });
                throw new Error(`Failed to move template: ${moveTemplateResult.stderr}`);
            }
            this.logger.info('✅ [CREATE_INSTANCE] Template moved successfully', { durationMs: moveDuration });

            this.logger.info('⚙️ [CREATE_INSTANCE] Step 4: Setting up instance', {
                instanceId,
                projectName,
                hasEnvVars: !!localEnvVars && Object.keys(localEnvVars).length > 0
            });
            const setupStartTime = Date.now();
            const setupPromise = () => this.setupInstance(instanceId, projectName, localEnvVars);
            const setupResult = await setupPromise();
            const setupDuration = Date.now() - setupStartTime;

            if (!setupResult) {
                this.logger.error('❌ [CREATE_INSTANCE] Setup failed - no results returned', {
                    instanceId,
                    durationMs: setupDuration
                });
                return {
                    success: false,
                    error: 'Failed to setup instance'
                };
            }

            this.logger.info('✅ [CREATE_INSTANCE] Instance setup completed', {
                instanceId,
                durationMs: setupDuration,
                hasPreviewURL: !!setupResult.previewURL,
                hasTunnelURL: !!setupResult.tunnelURL,
                hasProcessId: !!setupResult.processId,
                allocatedPort: setupResult.allocatedPort
            });

            results = setupResult;

            this.logger.info('💾 [CREATE_INSTANCE] Step 5: Storing instance metadata', { instanceId });
            const metadataStartTime = Date.now();
            // Store instance metadata
            const metadata = {
                templateName: templateName,
                projectName: projectName,
                startTime: new Date().toISOString(),
                webhookUrl: webhookUrl,
                previewURL: results?.previewURL,
                processId: results?.processId,
                tunnelURL: results?.tunnelURL,
                allocatedPort: results?.allocatedPort,
                donttouch_files: donttouchFiles,
                redacted_files: redactedFiles,
            };
            await this.storeInstanceMetadata(instanceId, metadata);
            const metadataDuration = Date.now() - metadataStartTime;
            this.logger.info('✅ [CREATE_INSTANCE] Metadata stored', {
                instanceId,
                durationMs: metadataDuration,
                previewURL: metadata.previewURL,
                tunnelURL: metadata.tunnelURL
            });

            const totalDuration = Date.now() - createStartTime;
            this.logger.info('🎉 [CREATE_INSTANCE] Instance creation completed successfully', {
                instanceId,
                templateName,
                projectName,
                totalDurationMs: totalDuration,
                previewURL: results?.previewURL,
                tunnelURL: results?.tunnelURL,
                processId: results?.processId
            });

            return {
                success: true,
                runId: instanceId,
                message: `Successfully created instance from template ${templateName}`,
                previewURL: results?.previewURL,
                tunnelURL: results?.tunnelURL,
                processId: results?.processId,
            };
        } catch (error) {
            const totalDuration = Date.now() - createStartTime;
            this.logger.error('❌ [CREATE_INSTANCE] Instance creation failed', {
                templateName,
                projectName,
                totalDurationMs: totalDuration,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            });
            return {
                success: false,
                error: `Failed to create instance: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getInstanceDetails(instanceId: string): Promise<GetInstanceResponse> {
        try {
            // Get instance metadata
            const metadata = await this.getInstanceMetadata(instanceId);
            if (!metadata) {
                return {
                    success: false,
                    error: `Instance ${instanceId} not found or metadata corrupted`
                };
            }

            const startTime = new Date(metadata.startTime);
            const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);

            // Get runtime errors
            const [fileTree, runtimeErrors] = await Promise.all([
                this.buildFileTree(instanceId),
                this.getInstanceErrors(instanceId)
            ]);

            const instanceDetails: InstanceDetails = {
                runId: instanceId,
                templateName: metadata.templateName,
                startTime,
                uptime,
                directory: instanceId,
                serviceDirectory: instanceId,
                fileTree,
                runtimeErrors: runtimeErrors.errors,
                previewURL: metadata.previewURL,
                processId: metadata.processId,
                tunnelURL: metadata.tunnelURL,
            };

            return {
                success: true,
                instance: instanceDetails
            };
        } catch (error) {
            this.logger.error('getInstanceDetails', error, { instanceId });
            return {
                success: false,
                error: `Failed to get instance details: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse> {
        try {
            // Check if instance exists by checking metadata
            const metadata = await this.getInstanceMetadata(instanceId);
            if (!metadata) {
                return {
                    success: false,
                    pending: false,
                    isHealthy: false,
                    error: `Instance ${instanceId} not found`
                };
            }

            let isHealthy = true;
            try {
                // Optionally check if process is still running
                if (metadata.processId) {
                    for (let i = 0; i < 3; i++) {
                        try {
                            const processes = await this.getSandbox().listProcesses();
                            const process = processes.find((p: { id: string; status: string }) => p.id === metadata.processId);
                            isHealthy = !!(process && process.status === 'running');
                            break;
                        } catch (error) {
                            this.logger.error(`Failed to check process ${metadata.processId}, retrying...${i + 1}/3`, { error });
                            isHealthy = false; // Process not found or not running
                        }
                    }
                }
            } catch {
                // No preview available
                isHealthy = false;
            }

            return {
                success: true,
                pending: false,
                isHealthy,
                message: isHealthy ? 'Instance is running normally' : 'Instance may have issues',
                previewURL: metadata.previewURL,
                tunnelURL: metadata.tunnelURL,
                processId: metadata.processId
            };
        } catch (error) {
            this.logger.error('getInstanceStatus', error, { instanceId });
            return {
                success: false,
                pending: false,
                isHealthy: false,
                error: `Failed to get instance status: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async shutdownInstance(instanceId: string): Promise<ShutdownResponse> {
        try {
            // Check if instance exists 
            const metadata = await this.getInstanceMetadata(instanceId);
            if (!metadata) {
                return {
                    success: false,
                    error: `Instance ${instanceId} not found`
                };
            }

            this.logger.info(`Shutting down instance: ${instanceId}`);

            const sandbox = this.getSandbox();

            if (metadata.processId) {
                try {
                    await sandbox.killProcess(metadata.processId);
                } catch (error) {
                    this.logger.warn(`Failed to kill process ${metadata.processId}`, error);
                }
            }

            // Unexpose the allocated port if we know what it was
            if (metadata.allocatedPort) {
                try {
                    await sandbox.unexposePort(metadata.allocatedPort);
                    this.logger.info(`Unexposed port ${metadata.allocatedPort} for instance ${instanceId}`);
                } catch (error) {
                    this.logger.warn(`Failed to unexpose port ${metadata.allocatedPort}`, error);
                }
            }

            // Clean up files
            await this.safeSandboxExec(`rm -rf ${instanceId}`);

            // Invalidate session cache
            this.invalidateSessionCache(instanceId);

            // Invalidate metadata cache since instance is being shutdown
            this.invalidateMetadataCache(instanceId);

            return {
                success: true,
                message: `Successfully shutdown instance ${instanceId}`
            };
        } catch (error) {
            this.logger.error('shutdownInstance', error, { instanceId });
            return {
                success: false,
                error: `Failed to shutdown instance: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    // ==========================================
    // FILE OPERATIONS
    // ==========================================

    async writeFiles(instanceId: string, files: WriteFilesRequest['files']): Promise<WriteFilesResponse> {
        const writeStartTime = Date.now();
        this.logger.info('✍️ [WRITE_FILES] Starting file write operation', {
            instanceId,
            fileCount: files.length,
            filePaths: files.map(f => f.filePath),
            totalSize: files.reduce((sum, f) => sum + f.fileContents.length, 0)
        });

        try {
            this.logger.info('🔍 [WRITE_FILES] Getting instance session', { instanceId });
            const session = await this.getInstanceSession(instanceId);
            this.logger.info('✅ [WRITE_FILES] Instance session obtained', { instanceId });

            const results = [];

            // Filter out donttouch files
            this.logger.info('🔍 [WRITE_FILES] Fetching instance metadata for donttouch files', { instanceId });
            const metadata = await this.getInstanceMetadata(instanceId);
            const donttouchFiles = new Set(metadata.donttouch_files);
            this.logger.info('📋 [WRITE_FILES] Metadata retrieved', {
                instanceId,
                donttouchFilesCount: donttouchFiles.size,
                donttouchFilesList: Array.from(donttouchFiles)
            });

            const filteredFiles = files.filter(file => !donttouchFiles.has(file.filePath));
            const filteredCount = files.length - filteredFiles.length;

            this.logger.info('🔍 [WRITE_FILES] Files filtered', {
                instanceId,
                originalCount: files.length,
                filteredCount: filteredFiles.length,
                skippedCount: filteredCount,
                skippedFiles: files.filter(f => donttouchFiles.has(f.filePath)).map(f => f.filePath)
            });

            // Use batch script for efficient writing (3 requests for any number of files)
            const filesToWrite = filteredFiles.map(file => ({
                path: `/workspace/${instanceId}/${file.filePath}`,
                content: file.fileContents
            }));

            this.logger.info('📝 [WRITE_FILES] Writing files via batch script', {
                instanceId,
                fileCount: filesToWrite.length,
                totalSize: filesToWrite.reduce((sum, f) => sum + f.content.length, 0)
            });

            const scriptStartTime = Date.now();
            const writeResults = await this.writeFilesViaScript(filesToWrite, session);
            const scriptDuration = Date.now() - scriptStartTime;

            this.logger.info('📊 [WRITE_FILES] Batch script completed', {
                instanceId,
                durationMs: scriptDuration,
                resultsCount: writeResults.length,
                successCount: writeResults.filter(r => r.success).length,
                failedCount: writeResults.filter(r => !r.success).length
            });

            // Map results back to original format
            for (const writeResult of writeResults) {
                results.push({
                    file: writeResult.file.replace(`/workspace/${instanceId}/`, ''),
                    success: writeResult.success,
                    error: writeResult.error
                });
            }

            // Add files that were not written to results
            const wereDontTouchFiles = files.filter(file => donttouchFiles.has(file.filePath));
            wereDontTouchFiles.forEach(file => {
                results.push({
                    file: file.filePath,
                    success: false,
                    error: 'File is forbidden to be modified'
                });
            });

            if (wereDontTouchFiles.length > 0) {
                this.logger.warn('🚫 [WRITE_FILES] Files were not written (protected by donttouch_files)', {
                    instanceId,
                    files: wereDontTouchFiles.map(f => f.filePath)
                });
            }

            const successCount = results.filter(r => r.success).length;
            const failedCount = results.filter(r => !r.success).length;
            const failedFiles = results.filter(r => !r.success).map(r => ({ file: r.file, error: r.error }));

            this.logger.info('📊 [WRITE_FILES] File write results summary', {
                instanceId,
                totalFiles: files.length,
                successCount,
                failedCount,
                successRate: `${((successCount / files.length) * 100).toFixed(1)}%`,
                failedFiles: failedFiles.length > 0 ? failedFiles : undefined
            });

            // If code files were modified, touch vite.config.ts to trigger a rebuild
            if (successCount > 0 && filteredFiles.some(file => file.filePath.endsWith('.ts') || file.filePath.endsWith('.tsx'))) {
                this.logger.info('🔄 [WRITE_FILES] Code files modified, touching vite.config.ts to trigger rebuild', { instanceId });
                try {
                    await session.exec(`touch vite.config.ts`);
                    this.logger.info('✅ [WRITE_FILES] vite.config.ts touched successfully', { instanceId });
                } catch (touchError) {
                    this.logger.warn('⚠️ [WRITE_FILES] Failed to touch vite.config.ts', { instanceId, error: touchError });
                }
            }

            const totalDuration = Date.now() - writeStartTime;
            this.logger.info('✅ [WRITE_FILES] File write operation completed', {
                instanceId,
                durationMs: totalDuration,
                successCount,
                failedCount,
                message: `Successfully wrote ${successCount}/${files.length} files`
            });

            return {
                success: true,
                results,
                message: `Successfully wrote ${successCount}/${files.length} files`
            };
        } catch (error) {
            const totalDuration = Date.now() - writeStartTime;
            this.logger.error('❌ [WRITE_FILES] File write operation failed', {
                instanceId,
                durationMs: totalDuration,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            });
            return {
                success: false,
                results: files.map(f => ({ file: f.filePath, success: false, error: 'Instance error' })),
                error: `Failed to write files: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async getFiles(templateOrInstanceId: string, filePaths?: string[], applyFilter: boolean = true, redactedFiles?: string[]): Promise<GetFilesResponse> {
        try {
            const session = await this.getInstanceSession(templateOrInstanceId);

            if (!filePaths) {
                // Read '.important_files.json' in instance directory
                const importantFiles = await session.exec(`jq -r '.[]' .important_files.json | while read -r path; do if [ -d "$path" ]; then find "$path" -type f; elif [ -f "$path" ]; then echo "$path"; fi; done`);
                this.logger.info(`Read important files: stdout: ${importantFiles.stdout}, stderr: ${importantFiles.stderr}`);
                filePaths = importantFiles.stdout.split('\n').filter((path: string) => path);
                if (!filePaths) {
                    return {
                        success: false,
                        files: [],
                        error: 'Failed to read important files'
                    };
                }
                this.logger.info(`Successfully read important files: ${filePaths}`);
                applyFilter = true;
            }

            let redactedPaths: Set<string> = new Set();

            if (applyFilter) {
                if (redactedFiles) {
                    redactedPaths = new Set(redactedFiles);
                } else {
                    try {
                        const metadata = await this.getInstanceMetadata(templateOrInstanceId);
                        redactedPaths = new Set(metadata.redacted_files);
                    } catch (error) {
                        this.logger.warn('Failed to get redacted files', { templateOrInstanceId });
                    }
                }
            }

            const files = [];
            const errors = [];

            const readPromises = filePaths.map(async (filePath: string) => {
                try {
                    const result = await session.readFile(`/workspace/${templateOrInstanceId}/${filePath}`);
                    return {
                        result,
                        filePath
                    };
                } catch (error) {
                    return {
                        result: null,
                        filePath,
                        error
                    };
                }
            });

            const readResults = await Promise.allSettled(readPromises);

            for (const readResult of readResults) {
                if (readResult.status === 'fulfilled') {
                    const { result, filePath } = readResult.value;
                    if (result && result.success) {
                        files.push({
                            filePath: filePath,
                            fileContents: (applyFilter && redactedPaths.has(filePath)) ? '[REDACTED]' : result.content
                        });

                        this.logger.info('File read successfully', { filePath });
                    } else {
                        this.logger.error('File read failed', { filePath });
                        errors.push({
                            file: filePath,
                            error: 'Failed to read file'
                        });
                    }
                } else {
                    this.logger.error(`Promise rejected for file read`);
                    errors.push({
                        file: 'unknown',
                        error: 'Promise rejected'
                    });
                }
            }

            return {
                success: true,
                files,
                errors: errors.length > 0 ? errors : undefined
            };
        } catch (error) {
            this.logger.error('getFiles', error, { templateOrInstanceId });
            return {
                success: false,
                files: [],
                error: `Failed to get files: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }
    // ==========================================
    // LOG RETRIEVAL
    // ==========================================
    async getLogs(instanceId: string, onlyRecent?: boolean, durationSeconds?: number): Promise<GetLogsResponse> {
        try {
            this.logger.info('Retrieving instance logs', { instanceId, durationSeconds });
            // Use CLI to get all logs and reset the file
            const durationArg = durationSeconds ? `--duration ${durationSeconds}` : '';
            const cmd = `timeout 10s monitor-cli logs get -i ${instanceId} --format raw ${onlyRecent ? '--reset' : ''} ${durationArg}`;
            const result = await this.executeCommand(instanceId, cmd, { timeout: 15000 });
            return {
                success: true,
                logs: {
                    stdout: result.stdout,
                    stderr: result.stderr,
                },
                error: undefined
            };
        } catch (error) {
            this.logger.error('getLogs', error, { instanceId });
            return {
                success: false,
                logs: {
                    stdout: '',
                    stderr: '',
                },
                error: `Failed to get logs: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    // ==========================================
    // COMMAND EXECUTION
    // ==========================================

    async executeCommands(instanceId: string, commands: string[], timeout?: number): Promise<ExecuteCommandsResponse> {
        try {
            const results: CommandExecutionResult[] = [];

            for (const command of commands) {
                try {
                    const result = await this.executeCommand(instanceId, command, { timeout });

                    results.push({
                        command,
                        success: result.exitCode === 0,
                        output: result.stdout,
                        error: result.stderr || undefined,
                        exitCode: result.exitCode
                    });

                    if (result.exitCode !== 0) {
                        this.logger.error('Command execution failed', { command, error: result.stderr });
                    }

                    this.logger.info('Command executed', { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
                } catch (error) {
                    this.logger.error('Command execution failed with error', { command, error });
                    results.push({
                        command,
                        success: false,
                        output: '',
                        error: error instanceof Error ? error.message : 'Execution error'
                    });
                }
            }

            const successCount = results.filter(r => r.success).length;
            return {
                success: true,
                results,
                message: `Executed ${successCount}/${commands.length} commands successfully`
            };
        } catch (error) {
            this.logger.error('executeCommands', error, { instanceId });
            return {
                success: false,
                results: commands.map(cmd => ({
                    command: cmd,
                    success: false,
                    output: '',
                    error: 'Instance error'
                })),
                error: `Failed to execute commands: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    // ==========================================
    // ERROR MANAGEMENT
    // ==========================================

    async getInstanceErrors(instanceId: string, clear?: boolean): Promise<RuntimeErrorResponse> {
        try {
            let errors: RuntimeError[] = [];
            const cmd = `timeout 3s monitor-cli errors list -i ${instanceId} --format json ${clear ? '--reset' : ''}`;
            const result = await this.executeCommand(instanceId, cmd, { timeout: 15000 });

            if (result.exitCode === 0) {
                let response: { success: boolean, errors: StoredError[] };
                try {
                    response = JSON.parse(result.stdout);
                    this.logger.info(`getInstanceErrors - ${response.errors.length ? 'errors found' : ''}: ${result.stdout}`);
                } catch (parseError) {
                    this.logger.warn('Failed to parse CLI output as JSON', { stdout: result.stdout });
                    throw new Error('Invalid JSON response from CLI tools');
                }
                if (response.success && response.errors) {
                    // Convert StoredError objects to RuntimeError format
                    errors = response.errors;

                    return {
                        success: true,
                        errors,
                        hasErrors: errors.length > 0
                    };
                }
            }
            this.logger.error(`Failed to get errors for instance ${instanceId}: STDERR: ${result.stderr}, STDOUT: ${result.stdout}`);

            return {
                success: false,
                errors: [],
                hasErrors: false,
                error: `Failed to get errors for instance ${instanceId}: STDERR: ${result.stderr}, STDOUT: ${result.stdout}`
            };
        } catch (error) {
            this.logger.error('getInstanceErrors', error, { instanceId });
            return {
                success: false,
                errors: [],
                hasErrors: false,
                error: `Failed to get errors: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    async clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse> {
        try {
            let clearedCount = 0;

            // Try enhanced error system first - clear ALL errors
            try {
                const cmd = `timeout 10s monitor-cli errors clear -i ${instanceId} --confirm`;
                const result = await this.executeCommand(instanceId, cmd, { timeout: 15000 }); // 15 second timeout

                if (result.exitCode === 0) {
                    let response: any;
                    try {
                        response = JSON.parse(result.stdout);
                    } catch (parseError) {
                        this.logger.warn('Failed to parse CLI output as JSON', { stdout: result.stdout });
                        throw new Error('Invalid JSON response from CLI tools');
                    }
                    if (response.success) {
                        return {
                            success: true,
                            message: response.message || `Cleared ${response.clearedCount || 0} errors`
                        };
                    }
                }
            } catch (enhancedError) {
                this.logger.warn('Error clearing unavailable, falling back to legacy', enhancedError);
            }

            this.logger.info(`Cleared ${clearedCount} errors for instance ${instanceId}`);

            return {
                success: true,
                message: `Cleared ${clearedCount} errors`
            };
        } catch (error) {
            this.logger.error('clearInstanceErrors', error, { instanceId });
            return {
                success: false,
                error: `Failed to clear errors: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    // ==========================================
    // CODE ANALYSIS & FIXING
    // ==========================================

    async runStaticAnalysisCode(instanceId: string): Promise<StaticAnalysisResponse> {
        try {
            const lintIssues: CodeIssue[] = [];
            const typecheckIssues: CodeIssue[] = [];

            // Run ESLint and TypeScript check in parallel
            const [lintResult, tscResult] = await Promise.allSettled([
                this.executeCommand(instanceId, 'bun run lint'),
                this.executeCommand(instanceId, 'bunx tsc -b --incremental --noEmit --pretty false')
            ]);

            const results: StaticAnalysisResponse = {
                success: true,
                lint: {
                    issues: [],
                    summary: {
                        errorCount: 0,
                        warningCount: 0,
                        infoCount: 0
                    },
                    rawOutput: ''
                },
                typecheck: {
                    issues: [],
                    summary: {
                        errorCount: 0,
                        warningCount: 0,
                        infoCount: 0
                    },
                    rawOutput: ''
                }
            };

            // Process ESLint results
            if (lintResult.status === 'fulfilled') {
                try {
                    const lintData = JSON.parse(lintResult.value.stdout) as Array<{
                        filePath: string;
                        messages: Array<{
                            message: string;
                            line?: number;
                            column?: number;
                            severity: number;
                            ruleId?: string;
                        }>;
                    }>;

                    for (const fileResult of lintData) {
                        for (const message of fileResult.messages || []) {
                            lintIssues.push({
                                message: message.message,
                                filePath: fileResult.filePath,
                                line: message.line || 0,
                                column: message.column,
                                severity: this.mapESLintSeverity(message.severity),
                                ruleId: message.ruleId || '',
                                source: 'eslint'
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn('Failed to parse ESLint output', error);
                }

                results.lint.issues = lintIssues;
                results.lint.summary = {
                    errorCount: lintIssues.filter(issue => issue.severity === 'error').length,
                    warningCount: lintIssues.filter(issue => issue.severity === 'warning').length,
                    infoCount: lintIssues.filter(issue => issue.severity === 'info').length
                };
                results.lint.rawOutput = `STDOUT: ${lintResult.value.stdout}\nSTDERR: ${lintResult.value.stderr}`;
            } else if (lintResult.status === 'rejected') {
                this.logger.warn('ESLint analysis failed', lintResult.reason);
            }

            // Process TypeScript check results
            if (tscResult.status === 'fulfilled') {
                try {
                    // TypeScript errors can come from either stdout or stderr
                    const output = tscResult.value.stderr || tscResult.value.stdout;

                    if (!output || output.trim() === '') {
                        this.logger.info('No TypeScript output to parse');
                    } else {
                        this.logger.info(`Parsing TypeScript output: ${output.substring(0, 200)}...`);

                        // Split by lines and parse each error
                        const lines = output.split('\n');
                        let currentError: any = null;

                        for (const line of lines) {
                            // Match TypeScript error format: path(line,col): error TSxxxx: message
                            const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
                            if (match) {
                                // If we have a previous error being built, add it
                                if (currentError) {
                                    typecheckIssues.push(currentError);
                                }

                                // Start building new error
                                currentError = {
                                    message: match[5].trim(),
                                    filePath: match[1].trim(),
                                    line: parseInt(match[2]),
                                    column: parseInt(match[3]),
                                    severity: 'error' as const,
                                    source: 'typescript',
                                    ruleId: `TS${match[4]}`
                                };

                                this.logger.info(`Found TypeScript error: ${currentError.filePath}:${currentError.line} - ${currentError.ruleId}`);
                            } else if (currentError && line.trim() && !line.startsWith('src/') && !line.includes(': error TS')) {
                                // This might be a continuation of the error message
                                currentError.message += ' ' + line.trim();
                            }
                        }

                        // Add the last error if it exists
                        if (currentError) {
                            typecheckIssues.push(currentError);
                        }

                        this.logger.info(`Parsed ${typecheckIssues.length} TypeScript errors`);
                    }
                } catch (error) {
                    this.logger.warn('Failed to parse TypeScript output', error);
                }

                results.typecheck.issues = typecheckIssues;
                results.typecheck.summary = {
                    errorCount: typecheckIssues.filter(issue => issue.severity === 'error').length,
                    warningCount: typecheckIssues.filter(issue => issue.severity === 'warning').length,
                    infoCount: typecheckIssues.filter(issue => issue.severity === 'info').length
                };
                results.typecheck.rawOutput = `STDOUT: ${tscResult.value.stdout}\nSTDERR: ${tscResult.value.stderr}`;
            } else if (tscResult.status === 'rejected') {
                this.logger.warn('TypeScript analysis failed', tscResult.reason);
            }

            this.logger.info(`Analysis completed: ${lintIssues.length} lint issues, ${typecheckIssues.length} typecheck issues`);

            return {
                ...results
            };
        } catch (error) {
            this.logger.error('runStaticAnalysisCode', error, { instanceId });
            return {
                success: false,
                lint: { issues: [] },
                typecheck: { issues: [] },
                error: `Failed to run analysis: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    private mapESLintSeverity(severity: number): LintSeverity {
        switch (severity) {
            case 1: return 'warning';
            case 2: return 'error';
            default: return 'info';
        }
    }

    // ==========================================
    // DEPLOYMENT
    // ==========================================
    /**
     * Deploy to Cloudflare Workers
     * @param instanceId - The sandbox instance ID
     * @param customSubdomain - Optional custom subdomain to use instead of default project name
     */
    async deployToCloudflareWorkers(instanceId: string, customSubdomain?: string): Promise<DeploymentResult> {
        try {
            this.logger.info('Starting deployment', { instanceId, customSubdomain });

            // Get project metadata
            const metadata = await this.getInstanceMetadata(instanceId);
            // Use custom subdomain if provided, otherwise fall back to projectName from metadata or instanceId
            const projectName = customSubdomain || metadata?.projectName || instanceId;

            // Get credentials from environment (secure - no exposure to external processes)
            const accountId = env.CLOUDFLARE_ACCOUNT_ID;
            const apiToken = env.CLOUDFLARE_API_TOKEN;

            if (!accountId || !apiToken) {
                throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in environment');
            }

            this.logger.info('Processing deployment', { instanceId });

            // Step 1: Run build commands (bun run build && bunx wrangler build)
            this.logger.info('Building project');
            const buildResult = await this.executeCommand(instanceId, 'bun run build');
            if (buildResult.exitCode !== 0) {
                this.logger.warn('Build step failed or not available', buildResult.stdout, buildResult.stderr);
                throw new Error(`Build failed: ${buildResult.stderr}`);
            }

            const wranglerBuildResult = await this.executeCommand(instanceId, 'bunx wrangler build');
            if (wranglerBuildResult.exitCode !== 0) {
                this.logger.warn('Wrangler build failed', wranglerBuildResult.stdout, wranglerBuildResult.stderr);
                // Continue anyway - some projects might not need wrangler build
            }

            // Step 2: Parse wrangler config from KV
            this.logger.info('Reading wrangler configuration from KV');
            let wranglerConfigContent = await env.VibecoderStore.get(this.getWranglerKVKey(instanceId));

            if (!wranglerConfigContent) {
                // This should never happen unless KV itself has some issues
                throw new Error(`Wrangler config not found in KV for ${instanceId}`);
            } else {
                this.logger.info('Using wrangler configuration from KV');
            }

            const config = parseWranglerConfig(wranglerConfigContent);

            this.logger.info('Worker configuration', { scriptName: config.name });
            this.logger.info('Worker compatibility', { compatibilityDate: config.compatibility_date });

            // Step 3: Read worker script from dist
            this.logger.info('Reading worker script');
            const session = await this.getInstanceSession(instanceId);
            const workerFile = await session.readFile(`/workspace/${instanceId}/dist/index.js`);
            if (!workerFile.success) {
                throw new Error(`Worker script not found at /${instanceId}/dist/index.js. Please build the project first.`);
            }

            const workerContent = workerFile.content;
            this.logger.info('Worker script loaded', { sizeKB: (workerContent.length / 1024).toFixed(2) });

            // Step 3a: Check for additional worker modules (ESM imports)
            // Process them the same way as assets but as strings for the Map
            let additionalModules: Map<string, string> | undefined;
            try {
                const workerAssetsPath = `${instanceId}/dist/assets`;
                const workerAssetsResult = await this.safeSandboxExec(`test -d ${workerAssetsPath} && echo "exists" || echo "missing"`);
                const hasWorkerAssets = workerAssetsResult.exitCode === 0 && workerAssetsResult.stdout.trim() === "exists";

                if (hasWorkerAssets) {
                    this.logger.info('Processing additional worker modules', { workerAssetsPath });

                    // Find all JS files in the worker assets directory
                    const findResult = await this.safeSandboxExec(`find ${workerAssetsPath} -type f -name "*.js"`);
                    if (findResult.exitCode === 0) {
                        const modulePaths = findResult.stdout.trim().split('\n').filter((path: string) => path.trim());

                        if (modulePaths.length > 0) {
                            additionalModules = new Map<string, string>();

                            for (const fullPath of modulePaths) {
                                const relativePath = fullPath.replace(`${instanceId}/dist/`, '');

                                try {
                                    const buffer = await this.readFileAsBase64Buffer(fullPath);
                                    const moduleContent = buffer.toString('utf8');
                                    additionalModules.set(relativePath, moduleContent);

                                    this.logger.info('Worker module loaded', {
                                        path: relativePath,
                                        sizeKB: (moduleContent.length / 1024).toFixed(2)
                                    });
                                } catch (error) {
                                    this.logger.warn(`Failed to read worker module ${fullPath}:`, error);
                                }
                            }

                            if (additionalModules.size > 0) {
                                this.logger.info('Found additional worker modules', { count: additionalModules.size });
                            }
                        }
                    }
                }
            } catch (error) {
                this.logger.error('Failed to process additional worker modules:', error);
            }

            // Step 4: Check for static assets and process them
            const assetsPath = `${instanceId}/dist/client`;
            let assetsManifest: Record<string, { hash: string; size: number }> | undefined;
            let fileContents: Map<string, Buffer> | undefined;

            const assetDirResult = await this.safeSandboxExec(`test -d ${assetsPath} && echo "exists" || echo "missing"`);
            const hasAssets = assetDirResult.exitCode === 0 && assetDirResult.stdout.trim() === "exists";

            if (hasAssets) {
                this.logger.info('Processing static assets', { assetsPath });
                const assetProcessResult = await this.processAssetsInSandbox(instanceId, assetsPath);
                assetsManifest = assetProcessResult.assetsManifest;
                fileContents = assetProcessResult.fileContents;
            } else {
                this.logger.info('No static assets found, deploying worker only');
            }

            // Step 5: Override config for dispatch deployment
            const dispatchConfig = {
                ...config,
                name: config.name
            };


            // Step 6: Build deployment config using pure function
            const deployConfig = buildDeploymentConfig(
                dispatchConfig,
                workerContent,
                accountId,
                apiToken,
                assetsManifest,
                config.compatibility_flags
            );

            // Step 7: Deploy using pure function
            this.logger.info('Deploying to Cloudflare');
            if ('DISPATCH_NAMESPACE' in env) {
                this.logger.info('Using dispatch namespace', { dispatchNamespace: env.DISPATCH_NAMESPACE });
                await deployToDispatch(
                    {
                        ...deployConfig,
                        dispatchNamespace: env.DISPATCH_NAMESPACE as string
                    },
                    fileContents,
                    additionalModules,
                    config.migrations,
                    config.assets
                );
            } else {
                throw new Error('DISPATCH_NAMESPACE not found in environment variables, cannot deploy without dispatch namespace');
            }

            // Step 8: Determine deployment URL
            const deployedUrl = `${this.getProtocolForHost()}://${projectName}.${getPreviewDomain(env)}`;
            const deploymentId = projectName;

            this.logger.info('Deployment successful', {
                instanceId,
                deployedUrl,
                deploymentId,
                mode: 'dispatch-namespace'
            });

            return {
                success: true,
                message: `Successfully deployed ${instanceId} using secure API deployment`,
                deployedUrl,
                deploymentId,
                output: `Deployed`
            };

        } catch (error) {
            this.logger.error('deployToCloudflareWorkers', error, { instanceId });
            return {
                success: false,
                message: `Deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Process static assets in sandbox and create manifest for deployment
     */
    private async processAssetsInSandbox(_instanceId: string, assetsPath: string): Promise<{
        assetsManifest: Record<string, { hash: string; size: number }>;
        fileContents: Map<string, Buffer>;
    }> {
        // Get list of all files in assets directory
        const findResult = await this.safeSandboxExec(`find ${assetsPath} -type f`);
        if (findResult.exitCode !== 0) {
            throw new Error(`Failed to list assets: ${findResult.stderr}`);
        }

        const filePaths = findResult.stdout.trim().split('\n').filter((path: string) => path);
        this.logger.info('Asset files found', { count: filePaths.length });

        const fileContents = new Map<string, Buffer>();
        const filesAsArrayBuffer = new Map<string, ArrayBuffer>();

        // Read each file and calculate hashes
        for (const fullPath of filePaths) {
            const relativePath = fullPath.replace(`${assetsPath}/`, '/');

            try {
                // Use base64 encoding to preserve binary files and Unicode
                const buffer = await this.readFileAsBase64Buffer(fullPath);
                fileContents.set(relativePath, buffer);

                const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
                filesAsArrayBuffer.set(relativePath, arrayBuffer);

                this.logger.info('Asset file processed', { path: relativePath, sizeBytes: buffer.length });
            } catch (error) {
                this.logger.warn(`Failed to read asset file ${fullPath}:`, error);
            }
        }

        // Create asset manifest using pure function
        const assetsManifest = await createAssetManifest(filesAsArrayBuffer);
        const assetCount = Object.keys(assetsManifest).length;
        this.logger.info('Asset manifest created', { assetCount });

        return { assetsManifest, fileContents };
    }

    /**
     * Read file from sandbox as base64 and convert to Buffer
     * Uses default session for deployment file operations with absolute paths
     */
    private async readFileAsBase64Buffer(filePath: string): Promise<Buffer> {
        // Use base64 with no line wrapping (-w 0) to preserve binary data
        const base64Result = await this.safeSandboxExec(`base64 -w 0 "${filePath}"`);
        if (base64Result.exitCode !== 0) {
            throw new Error(`Failed to encode file: ${base64Result.stderr}`);
        }

        return Buffer.from(base64Result.stdout, 'base64');
    }

    /**
     * Get protocol for host (utility method)
     */
    private getProtocolForHost(): string {
        // Simple heuristic - use https for production-like domains
        const previewDomain = getPreviewDomain(env);
        if (previewDomain.includes('localhost') || previewDomain.includes('127.0.0.1')) {
            return 'http';
        }
        return 'https';
    }
}