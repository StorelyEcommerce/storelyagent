import {
    IDeploymentManager,
    DeploymentParams,
    DeploymentResult,
    SandboxDeploymentCallbacks,
    CloudflareDeploymentCallbacks
} from '../interfaces/IDeploymentManager';
import { BootstrapResponse, StaticAnalysisResponse, RuntimeError, PreviewType } from '../../../services/sandbox/sandboxTypes';
import { FileOutputType } from '../../schemas';
import { generateId } from '../../../utils/idGenerator';
import { generateAppProxyToken, generateAppProxyUrl } from '../../../services/aigateway-proxy/controller';
import { BaseAgentService } from './BaseAgentService';
import { ServiceOptions } from '../interfaces/IServiceOptions';
import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';
import { getSandboxService } from '../../../services/sandbox/factory';
import { validateAndCleanBootstrapCommands } from 'worker/agents/utils/common';
import { isBackendReadOnlyFile } from 'worker/services/sandbox/utils';

const PER_ATTEMPT_TIMEOUT_MS = 60000;  // 60 seconds per individual attempt
const MASTER_DEPLOYMENT_TIMEOUT_MS = 300000;  // 5 minutes total
const HEALTH_CHECK_INTERVAL_MS = 30000;

/**
 * Manages deployment operations for sandbox instances
 * Handles instance creation, file deployment, analysis, and GitHub/Cloudflare export
 * Also manages sessionId and health check intervals
 */
export class DeploymentManager extends BaseAgentService implements IDeploymentManager {
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
    private currentDeploymentPromise: Promise<PreviewType | null> | null = null;
    private cachedSandboxClient: BaseSandboxService | null = null;

    constructor(
        options: ServiceOptions,
        private maxCommandsHistory: number
    ) {
        super(options);

        // Ensure state has sessionId
        const state = this.getState();
        if (!state.sessionId) {
            this.setState({
                ...state,
                sessionId: DeploymentManager.generateNewSessionId()
            });
        }
    }

    /**
     * Get current session ID from state
     */
    getSessionId(): string {
        return this.getState().sessionId;
    }

    /**
     * Cache is tied to current sessionId and invalidated on reset
     */
    public getClient(): BaseSandboxService {
        if (!this.cachedSandboxClient) {
            const logger = this.getLog();
            logger.info('Creating sandbox service client', {
                sessionId: this.getSessionId(),
                agentId: this.getAgentId()
            });
            this.cachedSandboxClient = getSandboxService(
                this.getSessionId(),
                this.getAgentId()
            );
        }
        return this.cachedSandboxClient;
    }

    /**
     * Reset session ID (called on timeout or specific errors)
     */
    resetSessionId(): void {
        const logger = this.getLog();
        const state = this.getState();
        const oldSessionId = state.sessionId;
        const newSessionId = DeploymentManager.generateNewSessionId();

        logger.info(`SessionId reset: ${oldSessionId} → ${newSessionId}`);

        // Reset session ID in logger
        logger.setFields({
            sessionId: newSessionId,
        });
        // Invalidate cached sandbox client (tied to old sessionId)
        this.cachedSandboxClient = null;

        // Update state
        this.setState({
            ...state,
            sessionId: newSessionId,
            sandboxInstanceId: undefined  // Clear instance on session reset
        });
    }

    static generateNewSessionId(): string {
        return generateId();
    }

    /**
     * Wait for preview to be ready
     */
    async waitForPreview(): Promise<void> {
        const state = this.getState();
        const logger = this.getLog();

        logger.info("Waiting for preview");

        if (!state.sandboxInstanceId) {
            logger.info("No sandbox instance, will create during next deploy");
        }

        logger.info("Waiting for preview completed");
    }

    /**
     * Execute setup commands (used during redeployment)
     * @param onAfterCommands Optional callback invoked after commands complete (e.g., for syncing package.json)
     */
    async executeSetupCommands(
        sandboxInstanceId: string,
        timeoutMs: number = 60000,
        onAfterCommands?: () => Promise<void>
    ): Promise<void> {
        const { commandsHistory } = this.getState();
        const logger = this.getLog();
        const client = this.getClient();

        if (!commandsHistory || commandsHistory.length === 0) {
            return;
        }

        // CRITICAL: Audit bootstrap commands before execution (safety net)
        const { validCommands, invalidCommands } = validateAndCleanBootstrapCommands(
            commandsHistory,
            this.maxCommandsHistory
        );

        if (invalidCommands.length > 0) {
            logger.warn('[commands] DANGEROUS COMMANDS DETECTED IN BOOTSTRAP - FILTERED OUT', {
                dangerous: invalidCommands,
                dangerousCount: invalidCommands.length,
                validCount: validCommands.length
            });
        }

        if (validCommands.length === 0) {
            logger.warn('[commands] No valid commands to execute after filtering');
            return;
        }

        logger.info(`[commands] Executing ${validCommands.length} validated setup commands on instance ${sandboxInstanceId}`);

        await this.withTimeout(
            client.executeCommands(sandboxInstanceId, validCommands),
            timeoutMs,
            'Command execution timed out'
        );

        logger.info('Setup commands executed successfully');

        // Invoke callback if provided (e.g., for package.json sync)
        if (onAfterCommands) {
            logger.info('Invoking post-command callback');
            await onAfterCommands();
        }
    }

    /**
     * Start health check interval for instance
     */
    private startHealthCheckInterval(instanceId: string): void {
        const logger = this.getLog();

        // Clear any existing interval
        this.clearHealthCheckInterval();

        logger.info(`Starting health check interval for instance ${instanceId}`);

        this.healthCheckInterval = setInterval(async () => {
            try {
                const client = this.getClient();
                const status = await client.getInstanceStatus(instanceId);

                if (!status.success || !status.isHealthy) {
                    if (this.getState().isDeepDebugging) {
                        logger.info("Deep debugging active, skipping redeploy");
                        return;
                    }
                    logger.warn(`Instance ${instanceId} unhealthy, triggering redeploy`);
                    this.clearHealthCheckInterval();

                    // Trigger redeploy to recover from unhealthy state
                    try {
                        await this.deployToSandbox();
                        logger.info('Instance redeployed successfully after health check failure');
                    } catch (redeployError) {
                        logger.error('Failed to redeploy after health check failure:', redeployError);
                    }
                }
            } catch (error) {
                logger.error('Health check failed:', error);
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private clearHealthCheckInterval(): void {
        if (this.healthCheckInterval !== null) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Run static analysis (lint + typecheck) on code
     */
    async runStaticAnalysis(files?: string[]): Promise<StaticAnalysisResponse> {
        const { sandboxInstanceId } = this.getState();

        if (!sandboxInstanceId) {
            throw new Error('No sandbox instance available for static analysis');
        }

        const logger = this.getLog();
        const client = this.getClient();

        logger.info(`Linting code in sandbox instance ${sandboxInstanceId}`);

        const targetFiles = Array.isArray(files) && files.length > 0
            ? files
            : this.fileManager.getGeneratedFilePaths();

        const analysisResponse = await client.runStaticAnalysisCode(
            sandboxInstanceId,
            targetFiles
        );

        if (!analysisResponse || analysisResponse.error) {
            const errorMsg = `Code linting failed: ${analysisResponse?.error || 'Unknown error'}`;
            logger.error(errorMsg, { fullResponse: analysisResponse });
            throw new Error(errorMsg);
        }

        const { lint, typecheck } = analysisResponse;
        const { issues: lintIssues, summary: lintSummary } = lint;
        const { issues: typeCheckIssues, summary: typeCheckSummary } = typecheck;

        logger.info(`Linting found ${lintIssues.length} issues: ` +
            `${lintSummary?.errorCount || 0} errors, ` +
            `${lintSummary?.warningCount || 0} warnings, ` +
            `${lintSummary?.infoCount || 0} info`);

        logger.info(`Type checking found ${typeCheckIssues.length} issues: ` +
            `${typeCheckSummary?.errorCount || 0} errors, ` +
            `${typeCheckSummary?.warningCount || 0} warnings, ` +
            `${typeCheckSummary?.infoCount || 0} info`);

        return analysisResponse;
    }

    /**
     * Fetch runtime errors from sandbox instance
     */
    async fetchRuntimeErrors(clear: boolean = true): Promise<RuntimeError[]> {
        const { sandboxInstanceId } = this.getState();
        const logger = this.getLog();
        const client = this.getClient();

        if (!sandboxInstanceId) {
            throw new Error('No sandbox instance available for runtime error fetching');
        }

        const resp = await client.getInstanceErrors(sandboxInstanceId, clear);

        if (!resp || !resp.success) {
            throw new Error(`Failed to fetch runtime errors: ${resp?.error || 'Unknown error'}`);
        }

        let errors = resp.errors || [];

        // Filter out 'failed to connect to websocket' errors
        errors = errors.filter(e => e.message.includes('[vite] failed to connect to websocket'));

        if (errors.length > 0) {
            logger.info(`Found ${errors.length} runtime errors: ${errors.map(e => e.message).join(', ')}`);
        }

        return errors;
    }

    /**
     * Main deployment method
     * Callbacks allow agent to broadcast at the right times
     * All concurrent callers share the same promise and wait together
     * Retries indefinitely until success or master timeout (5 minutes)
     */
    async deployToSandbox(
        files: FileOutputType[] = [],
        redeploy: boolean = false,
        commitMessage?: string,
        clearLogs: boolean = false,
        callbacks?: SandboxDeploymentCallbacks
    ): Promise<PreviewType | null> {
        const logger = this.getLog();
        const deployStartTime = Date.now();

        logger.info('🚀 [DEPLOY_TO_SANDBOX] Deploy to sandbox requested', {
            filesCount: files.length,
            redeploy,
            commitMessage,
            clearLogs,
            sessionId: this.getSessionId(),
            hasCallbacks: !!callbacks
        });

        // All concurrent callers wait on the same promise
        if (this.currentDeploymentPromise) {
            logger.info('⏳ [DEPLOY_TO_SANDBOX] Deployment already in progress, waiting for completion', {
                sessionId: this.getSessionId()
            });
            const waitStartTime = Date.now();
            const result = await this.withTimeout(
                this.currentDeploymentPromise,
                MASTER_DEPLOYMENT_TIMEOUT_MS,
                'Deployment failed after 5 minutes'
            ).catch(() => {
                const waitDuration = Date.now() - waitStartTime;
                logger.warn('⏱️ [DEPLOY_TO_SANDBOX] Wait for existing deployment timed out', {
                    durationMs: waitDuration,
                    timeoutMs: MASTER_DEPLOYMENT_TIMEOUT_MS
                });
                return null;
            });
            const waitDuration = Date.now() - waitStartTime;
            logger.info('✅ [DEPLOY_TO_SANDBOX] Waited for existing deployment', {
                durationMs: waitDuration,
                hasResult: !!result
            });
            return result;
        }

        logger.info("🚀 [DEPLOY_TO_SANDBOX] Starting new deployment", {
            filesCount: files.length,
            redeploy,
            commitMessage,
            clearLogs,
            sessionId: this.getSessionId(),
            masterTimeoutMs: MASTER_DEPLOYMENT_TIMEOUT_MS
        });

        // Create deployment promise
        this.currentDeploymentPromise = this.executeDeploymentWithRetry(
            files,
            redeploy,
            commitMessage,
            clearLogs,
            callbacks
        );

        try {
            // Master timeout: 5 minutes total
            // This doesn't break the underlying operation - it just stops waiting
            logger.info('⏱️ [DEPLOY_TO_SANDBOX] Waiting for deployment with master timeout', {
                timeoutMs: MASTER_DEPLOYMENT_TIMEOUT_MS
            });
            const result = await this.withTimeout(
                this.currentDeploymentPromise,
                MASTER_DEPLOYMENT_TIMEOUT_MS,
                'Deployment failed after 5 minutes of retries'
                // No onTimeout callback - don't break the operation
            );
            const totalDuration = Date.now() - deployStartTime;
            logger.info('✅ [DEPLOY_TO_SANDBOX] Deployment completed successfully', {
                totalDurationMs: totalDuration,
                hasResult: !!result,
                previewURL: result?.previewURL,
                tunnelURL: result?.tunnelURL
            });
            return result;
        } catch (error) {
            // Master timeout reached - all retries exhausted
            const totalDuration = Date.now() - deployStartTime;
            logger.error('❌ [DEPLOY_TO_SANDBOX] Deployment permanently failed after master timeout', {
                totalDurationMs: totalDuration,
                timeoutMs: MASTER_DEPLOYMENT_TIMEOUT_MS,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined
            });
            return null;
        } finally {
            const totalDuration = Date.now() - deployStartTime;
            logger.info('🧹 [DEPLOY_TO_SANDBOX] Cleaning up deployment promise', {
                totalDurationMs: totalDuration
            });
            this.currentDeploymentPromise = null;
        }
    }

    /**
     * Execute deployment with infinite retry until success
     * Each attempt has its own timeout
     * Resets sessionId after consecutive failures
     */
    private async executeDeploymentWithRetry(
        files: FileOutputType[],
        redeploy: boolean,
        commitMessage: string | undefined,
        clearLogs: boolean,
        callbacks?: SandboxDeploymentCallbacks
    ): Promise<PreviewType> {
        const logger = this.getLog();
        let attempt = 0;
        const maxAttemptsBeforeSessionReset = 3;
        const retryStartTime = Date.now();

        logger.info('🔄 [RETRY_LOOP] Starting deployment retry loop', {
            filesCount: files.length,
            redeploy,
            commitMessage,
            clearLogs,
            sessionId: this.getSessionId(),
            perAttemptTimeoutMs: PER_ATTEMPT_TIMEOUT_MS,
            masterTimeoutMs: MASTER_DEPLOYMENT_TIMEOUT_MS
        });

        while (true) {
            attempt++;
            const attemptStartTime = Date.now();
            logger.info(`🔄 [RETRY_LOOP] Deployment attempt ${attempt} starting`, {
                sessionId: this.getSessionId(),
                elapsedTimeMs: attemptStartTime - retryStartTime
            });

            try {
                // Callback: deployment starting (only on first attempt)
                if (attempt === 1) {
                    logger.info('📢 [RETRY_LOOP] Sending deployment started callback', { attempt });
                    callbacks?.onStarted?.({
                        message: "Deploying code to sandbox service",
                        files: files.map(f => ({ filePath: f.filePath }))
                    });
                }

                // Core deployment with per-attempt timeout
                logger.info('⏱️ [RETRY_LOOP] Starting deploy with timeout', {
                    attempt,
                    timeoutMs: PER_ATTEMPT_TIMEOUT_MS
                });
                const deployPromise = this.deploy({
                    files,
                    redeploy,
                    commitMessage,
                    clearLogs
                });

                const deployStartTime = Date.now();
                const result = await this.withTimeout(
                    deployPromise,
                    PER_ATTEMPT_TIMEOUT_MS,
                    `Deployment attempt ${attempt} timed out`
                    // No onTimeout callback - don't break anything
                );
                const deployDuration = Date.now() - deployStartTime;

                logger.info('✅ [RETRY_LOOP] Deploy completed successfully', {
                    attempt,
                    durationMs: deployDuration,
                    sandboxInstanceId: result.sandboxInstanceId,
                    hasPreviewURL: !!result.previewURL,
                    hasTunnelURL: !!result.tunnelURL,
                    redeployed: result.redeployed
                });

                // Success! Start health check and return
                if (result.redeployed || this.healthCheckInterval === null) {
                    logger.info('🏥 [RETRY_LOOP] Starting health check interval', {
                        instanceId: result.sandboxInstanceId,
                        redeployed: result.redeployed,
                        hasExistingHealthCheck: this.healthCheckInterval !== null
                    });
                    this.startHealthCheckInterval(result.sandboxInstanceId);

                    // Execute setup commands with callback
                    logger.info('⚙️ [RETRY_LOOP] Executing setup commands', {
                        instanceId: result.sandboxInstanceId
                    });
                    const commandsStartTime = Date.now();
                    await this.executeSetupCommands(
                        result.sandboxInstanceId,
                        undefined,
                        callbacks?.onAfterSetupCommands
                    );
                    const commandsDuration = Date.now() - commandsStartTime;
                    logger.info('✅ [RETRY_LOOP] Setup commands completed', {
                        instanceId: result.sandboxInstanceId,
                        durationMs: commandsDuration
                    });
                }

                const preview = {
                    runId: result.sandboxInstanceId,
                    previewURL: result.previewURL,
                    tunnelURL: result.tunnelURL
                };

                const totalDuration = Date.now() - retryStartTime;
                logger.info('📢 [RETRY_LOOP] Sending deployment completed callback', {
                    attempt,
                    totalDurationMs: totalDuration
                });
                callbacks?.onCompleted?.({
                    message: "Deployment completed",
                    instanceId: preview.runId,
                    previewURL: preview.previewURL ?? '',
                    tunnelURL: preview.tunnelURL ?? ''
                });

                logger.info('🎉 [RETRY_LOOP] Deployment succeeded', {
                    attempt,
                    totalDurationMs: totalDuration,
                    sessionId: this.getSessionId(),
                    previewURL: preview.previewURL,
                    tunnelURL: preview.tunnelURL
                });
                return preview;

            } catch (error) {
                const attemptDuration = Date.now() - attemptStartTime;
                const errorMsg = error instanceof Error ? error.message : String(error);

                logger.warn(`❌ [RETRY_LOOP] Deployment attempt ${attempt} failed`, {
                    attempt,
                    durationMs: attemptDuration,
                    error: errorMsg,
                    errorType: error instanceof Error ? error.constructor.name : typeof error,
                    errorStack: error instanceof Error ? error.stack : undefined
                });

                // Handle specific errors that require session reset
                if (errorMsg.includes('Network connection lost') ||
                    errorMsg.includes('Container service disconnected') ||
                    errorMsg.includes('Internal error in Durable Object storage')) {
                    logger.warn('🔄 [RETRY_LOOP] Session-level error detected, resetting sessionId', {
                        errorMsg,
                        attempt
                    });
                    this.resetSessionId();
                }

                // After consecutive failures, reset session to get fresh sandbox
                if (attempt % maxAttemptsBeforeSessionReset === 0) {
                    logger.warn(`🔄 [RETRY_LOOP] ${attempt} consecutive failures, resetting sessionId for fresh sandbox`, {
                        attempt,
                        maxAttemptsBeforeSessionReset
                    });
                    this.resetSessionId();
                }

                // Clear instance ID from state
                logger.info('🧹 [RETRY_LOOP] Clearing instance ID from state', {
                    oldInstanceId: this.getState().sandboxInstanceId
                });
                this.setState({
                    ...this.getState(),
                    sandboxInstanceId: undefined
                });

                logger.info('📢 [RETRY_LOOP] Sending deployment error callback', { attempt });
                callbacks?.onError?.({
                    error: `Deployment attempt ${attempt} failed: ${errorMsg}`
                });

                // Exponential backoff before retry (capped at 30 seconds)
                const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt - 1, 5)), 30000);
                logger.info(`⏳ [RETRY_LOOP] Retrying deployment in ${backoffMs}ms...`, {
                    attempt,
                    backoffMs,
                    nextAttempt: attempt + 1
                });
                await new Promise(resolve => setTimeout(resolve, backoffMs));

                // Loop continues - retry indefinitely until master timeout
            }
        }
    }


    /**
     * Deploy files to sandbox instance (core deployment)
     */
    private async deploy(params: DeploymentParams): Promise<DeploymentResult> {
        const { files, redeploy, commitMessage, clearLogs } = params;
        const logger = this.getLog();
        const state = this.getState();

        logger.info("🚀 [DEPLOY] Starting deploy to sandbox service", {
            filesCount: files.length,
            redeploy,
            commitMessage,
            clearLogs,
            sessionId: this.getSessionId(),
            generatedFilesMapSize: Object.keys(state.generatedFilesMap || {}).length,
            generatedFilesMapKeys: Object.keys(state.generatedFilesMap || {}).slice(0, 30), // Log first 30 keys
            templateName: state.templateName,
            projectName: state.projectName
        });

        // Ensure instance exists and is healthy
        logger.info("🔍 [DEPLOY] Step 1: Ensuring instance exists and is healthy", { redeploy });
        const instanceResult = await this.ensureInstance(redeploy);
        const { sandboxInstanceId, previewURL, tunnelURL, redeployed } = instanceResult;

        logger.info("✅ [DEPLOY] Instance check complete", {
            sandboxInstanceId,
            previewURL,
            tunnelURL,
            redeployed,
            hasPreviewURL: !!previewURL,
            hasTunnelURL: !!tunnelURL
        });

        // Determine which files to deploy
        logger.info("📋 [DEPLOY] Step 2: Determining files to deploy", {
            requestedFilesCount: files.length,
            redeployed,
            requestedFilePaths: files.length > 0 ? files.map(f => f.filePath).slice(0, 20) : [] // Log first 20 requested files
        });
        const filesToWrite = this.getFilesToDeploy(files, redeployed);

        // Categorize files for better visibility
        const storefrontFiles = filesToWrite.filter(f => f.filePath.startsWith('storefront-app/'));
        const rootFiles = filesToWrite.filter(f => !f.filePath.includes('/') || f.filePath.split('/').length === 1);
        const otherFiles = filesToWrite.filter(f => !f.filePath.startsWith('storefront-app/') && f.filePath.includes('/') && f.filePath.split('/').length > 1);

        logger.info("📦 [DEPLOY] Files to deploy determined - categorized", {
            filesToWriteCount: filesToWrite.length,
            storefrontFilesCount: storefrontFiles.length,
            rootFilesCount: rootFiles.length,
            otherFilesCount: otherFiles.length,
            totalSize: filesToWrite.reduce((sum, f) => sum + f.fileContents.length, 0),
            storefrontFilePaths: storefrontFiles.map(f => f.filePath).slice(0, 30), // Log first 30 storefront files
            rootFilePaths: rootFiles.map(f => f.filePath),
            otherFilePaths: otherFiles.map(f => f.filePath).slice(0, 20), // Log first 20 other files
            allFilePaths: filesToWrite.map(f => f.filePath) // Log all file paths for complete visibility
        });

        // Write files if any
        if (filesToWrite.length > 0) {
            logger.info("✍️ [DEPLOY] Step 3: Writing files to sandbox instance", {
                instanceId: sandboxInstanceId,
                fileCount: filesToWrite.length
            });

            const writeStartTime = Date.now();
            const writeResponse = await this.getClient().writeFiles(
                sandboxInstanceId,
                filesToWrite,
                commitMessage
            );
            const writeDuration = Date.now() - writeStartTime;

            logger.info("📝 [DEPLOY] File write operation completed", {
                instanceId: sandboxInstanceId,
                durationMs: writeDuration,
                success: writeResponse?.success,
                message: writeResponse?.message,
                resultsCount: writeResponse?.results?.length || 0
            });

            if (!writeResponse || !writeResponse.success) {
                logger.error("❌ [DEPLOY] File writing failed", {
                    error: writeResponse?.error,
                    results: writeResponse?.results,
                    failedFiles: writeResponse?.results?.filter(r => !r.success).map(r => r.file)
                });
                throw new Error(`File writing failed. Error: ${writeResponse?.error}`);
            }

            // Log detailed results
            const successCount = writeResponse.results?.filter(r => r.success).length || 0;
            const failedCount = writeResponse.results?.filter(r => !r.success).length || 0;
            const successfulFiles = writeResponse.results?.filter(r => r.success).map(r => r.file) || [];
            const failedFiles = writeResponse.results?.filter(r => !r.success).map(r => ({ file: r.file, error: r.error })) || [];

            // Categorize successful files for better visibility
            const successfulStorefrontFiles = successfulFiles.filter(f => f.startsWith('storefront-app/'));
            const successfulRootFiles = successfulFiles.filter(f => !f.includes('/') || f.split('/').length === 1);

            logger.info('✅ [DEPLOY] Files written to sandbox instance - detailed breakdown', {
                instanceId: sandboxInstanceId,
                successCount,
                failedCount,
                totalFiles: filesToWrite.length,
                successfulStorefrontFilesCount: successfulStorefrontFiles.length,
                successfulRootFilesCount: successfulRootFiles.length,
                successfulFiles: successfulFiles,
                successfulStorefrontFiles: successfulStorefrontFiles.slice(0, 30), // Log first 30
                successfulRootFiles: successfulRootFiles,
                failedFiles: failedFiles,
                failedFilesCount: failedFiles.length,
                writeDurationMs: writeDuration
            });

            // Warn if significant number of files failed
            if (failedCount > 0) {
                const failureRate = (failedCount / filesToWrite.length) * 100;
                logger.warn('⚠️ [DEPLOY] Some files failed to write', {
                    failedCount,
                    totalFiles: filesToWrite.length,
                    failureRate: `${failureRate.toFixed(1)}%`,
                    failedFiles: failedFiles
                });
            }

            // Log if we're missing expected storefront files
            const expectedStorefrontFiles = filesToWrite.filter(f => f.filePath.startsWith('storefront-app/'));
            const writtenStorefrontFiles = successfulStorefrontFiles;
            if (expectedStorefrontFiles.length > writtenStorefrontFiles.length) {
                const missingStorefrontFiles = expectedStorefrontFiles
                    .map(f => f.filePath)
                    .filter(path => !writtenStorefrontFiles.includes(path));
                logger.warn('⚠️ [DEPLOY] Some storefront files were not written', {
                    expectedCount: expectedStorefrontFiles.length,
                    writtenCount: writtenStorefrontFiles.length,
                    missingFiles: missingStorefrontFiles
                });
            }
        } else {
            logger.info("⏭️ [DEPLOY] No files to write, skipping file write step");
        }

        // Clear logs if requested
        if (clearLogs) {
            try {
                logger.info('🧹 [DEPLOY] Step 4: Clearing logs and runtime errors', { instanceId: sandboxInstanceId });
                await Promise.all([
                    this.getClient().getLogs(sandboxInstanceId, true),
                    this.getClient().clearInstanceErrors(sandboxInstanceId)
                ]);
                logger.info('✅ [DEPLOY] Logs and errors cleared successfully');
            } catch (error) {
                logger.error('❌ [DEPLOY] Failed to clear logs and runtime errors', { error, instanceId: sandboxInstanceId });
            }
        }

        logger.info("🎉 [DEPLOY] Deployment completed successfully", {
            sandboxInstanceId,
            previewURL,
            tunnelURL,
            redeployed,
            filesWritten: filesToWrite.length
        });

        return {
            sandboxInstanceId,
            previewURL,
            tunnelURL,
            redeployed
        };
    }

    /**
     * Ensure sandbox instance exists and is healthy
     */
    async ensureInstance(redeploy: boolean): Promise<DeploymentResult> {
        const state = this.getState();
        const { sandboxInstanceId } = state;
        const logger = this.getLog();
        const client = this.getClient();

        logger.info("🔍 [ENSURE_INSTANCE] Checking instance status", {
            existingInstanceId: sandboxInstanceId,
            redeploy,
            templateName: state.templateName,
            projectName: state.projectName
        });

        // Check existing instance if not forcing redeploy
        if (sandboxInstanceId && !redeploy) {
            logger.info("🔍 [ENSURE_INSTANCE] Checking existing instance health", { instanceId: sandboxInstanceId });
            const statusStartTime = Date.now();
            const status = await client.getInstanceStatus(sandboxInstanceId);
            const statusDuration = Date.now() - statusStartTime;

            logger.info("📊 [ENSURE_INSTANCE] Instance status check completed", {
                instanceId: sandboxInstanceId,
                durationMs: statusDuration,
                success: status.success,
                isHealthy: status.isHealthy,
                pending: status.pending,
                previewURL: status.previewURL,
                tunnelURL: status.tunnelURL,
                message: status.message,
                error: status.error
            });

            if (status.success && status.isHealthy) {
                logger.info(`✅ [ENSURE_INSTANCE] Instance is healthy and ready`, {
                    instanceId: sandboxInstanceId,
                    previewURL: status.previewURL,
                    tunnelURL: status.tunnelURL
                });
                return {
                    sandboxInstanceId,
                    previewURL: status.previewURL,
                    tunnelURL: status.tunnelURL,
                    redeployed: false
                };
            }
            logger.warn(`⚠️ [ENSURE_INSTANCE] Instance check failed, will create new instance`, {
                instanceId: sandboxInstanceId,
                statusSuccess: status.success,
                isHealthy: status.isHealthy,
                error: status.error
            });
        } else {
            if (redeploy) {
                logger.info("🔄 [ENSURE_INSTANCE] Redeploy requested, creating new instance");
            } else {
                logger.info("🆕 [ENSURE_INSTANCE] No existing instance, creating new one");
            }
        }

        logger.info("🏗️ [ENSURE_INSTANCE] Creating new instance", {
            templateName: state.templateName,
            projectName: state.projectName
        });
        const createStartTime = Date.now();
        const results = await this.createNewInstance();
        const createDuration = Date.now() - createStartTime;

        logger.info("📊 [ENSURE_INSTANCE] Instance creation completed", {
            durationMs: createDuration,
            success: !!results,
            runId: results?.runId,
            previewURL: results?.previewURL,
            tunnelURL: results?.tunnelURL,
            processId: results?.processId,
            message: results?.message,
            error: !results ? 'No results returned' : undefined
        });

        if (!results || !results.runId || !results.previewURL) {
            logger.error("❌ [ENSURE_INSTANCE] Failed to create new instance", {
                results: results ? {
                    runId: results.runId,
                    hasPreviewURL: !!results.previewURL,
                    hasTunnelURL: !!results.tunnelURL,
                    message: results.message
                } : null
            });
            throw new Error(`Failed to create new deployment: ${results?.message || 'Unknown error'}`);
        }

        // Update state with new instance ID
        logger.info("💾 [ENSURE_INSTANCE] Updating state with new instance ID", {
            oldInstanceId: sandboxInstanceId,
            newInstanceId: results.runId
        });
        this.setState({
            ...this.getState(),
            sandboxInstanceId: results.runId,
        });

        logger.info("✅ [ENSURE_INSTANCE] Instance ensured successfully", {
            sandboxInstanceId: results.runId,
            previewURL: results.previewURL,
            tunnelURL: results.tunnelURL,
            redeployed: true
        });

        return {
            sandboxInstanceId: results.runId,
            previewURL: results.previewURL,
            tunnelURL: results.tunnelURL,
            redeployed: true
        };
    }


    /**
     * Create new sandbox instance
     */
    private async createNewInstance(): Promise<BootstrapResponse | null> {
        const state = this.getState();
        const templateName = state.templateName;
        const projectName = state.projectName;
        const logger = this.getLog();

        logger.info("🏗️ [CREATE_INSTANCE] Starting instance creation", {
            templateName,
            projectName,
            sessionId: this.getSessionId()
        });

        // Add AI proxy vars if AI template
        let localEnvVars: Record<string, string> = {};
        if (state.templateName?.includes('agents')) {
            logger.info("🤖 [CREATE_INSTANCE] Detected AI template, setting up proxy vars");
            const secret = this.env.AI_PROXY_JWT_SECRET;
            if (typeof secret === 'string' && secret.trim().length > 0) {
                localEnvVars = {
                    "CF_AI_BASE_URL": generateAppProxyUrl(this.env),
                    "CF_AI_API_KEY": await generateAppProxyToken(
                        state.inferenceContext.agentId,
                        state.inferenceContext.userId,
                        this.env
                    )
                };
                logger.info("✅ [CREATE_INSTANCE] AI proxy vars configured", {
                    hasBaseUrl: !!localEnvVars.CF_AI_BASE_URL,
                    hasApiKey: !!localEnvVars.CF_AI_API_KEY
                });
            } else {
                logger.warn("⚠️ [CREATE_INSTANCE] AI template detected but no JWT secret available");
            }
        }

        // Create instance
        const client = this.getClient();
        const finalProjectName = `v1-${projectName}`;

        logger.info("📞 [CREATE_INSTANCE] Calling sandbox client createInstance", {
            templateName,
            projectName: finalProjectName,
            hasEnvVars: Object.keys(localEnvVars).length > 0,
            envVarKeys: Object.keys(localEnvVars)
        });

        const createStartTime = Date.now();
        const createResponse = await client.createInstance(
            templateName,
            finalProjectName,
            undefined,
            localEnvVars
        );
        const createDuration = Date.now() - createStartTime;

        logger.info("📊 [CREATE_INSTANCE] createInstance call completed", {
            durationMs: createDuration,
            success: createResponse?.success,
            runId: createResponse?.runId,
            previewURL: createResponse?.previewURL,
            tunnelURL: createResponse?.tunnelURL,
            processId: createResponse?.processId,
            message: createResponse?.message,
            error: createResponse?.error
        });

        if (!createResponse || !createResponse.success || !createResponse.runId) {
            logger.error("❌ [CREATE_INSTANCE] Instance creation failed", {
                response: createResponse ? {
                    success: createResponse.success,
                    runId: createResponse.runId,
                    error: createResponse.error,
                    message: createResponse.message
                } : null
            });
            throw new Error(`Failed to create sandbox instance: ${createResponse?.error || 'Unknown error'}`);
        }

        logger.info(`✅ [CREATE_INSTANCE] Sandbox instance created successfully`, {
            runId: createResponse.runId,
            previewURL: createResponse.previewURL,
            tunnelURL: createResponse.tunnelURL,
            processId: createResponse.processId,
            durationMs: createDuration
        });

        if (createResponse.runId && createResponse.previewURL) {
            logger.info("✅ [CREATE_INSTANCE] Instance validation passed", {
                hasRunId: !!createResponse.runId,
                hasPreviewURL: !!createResponse.previewURL
            });
            return createResponse;
        }

        logger.error("❌ [CREATE_INSTANCE] Instance created but missing required fields", {
            hasRunId: !!createResponse.runId,
            hasPreviewURL: !!createResponse.previewURL,
            runId: createResponse.runId,
            previewURL: createResponse.previewURL
        });
        throw new Error(`Failed to create sandbox instance: Missing runId or previewURL`);
    }

    /**
     * Determine which files to deploy
     * Filters out backend read-only files (api-worker/, worker/)
     */
    private getFilesToDeploy(
        requestedFiles: FileOutputType[],
        redeployed: boolean
    ): Array<{ filePath: string; fileContents: string }> {
        const state = this.getState();
        const logger = this.getLog();

        logger.info("📋 [GET_FILES_TO_DEPLOY] Determining files to deploy", {
            requestedFilesCount: requestedFiles?.length || 0,
            redeployed,
            generatedFilesCount: Object.keys(state.generatedFilesMap || {}).length,
            generatedFilePaths: Object.keys(state.generatedFilesMap || {}).slice(0, 20) // Log first 20 generated files
        });

        // If no files requested or redeploying, use all files (template + generated)
        // This ensures template files are included even if they haven't been customized yet
        // This is critical when redeploying, as the instance may be recreated and needs all files
        if (!requestedFiles || requestedFiles.length === 0 || redeployed) {
            logger.info("📦 [GET_FILES_TO_DEPLOY] Using all files (template + generated)", {
                reason: !requestedFiles || requestedFiles.length === 0 ? 'no files requested' : 'redeployed',
                generatedFilesCount: Object.keys(state.generatedFilesMap || {}).length
            });
            // Use getAllFiles to include ALL template files (not just important ones) for deployment
            // This ensures the full template is deployed, not just customized files
            requestedFiles = this.fileManager.getAllFiles();

            // Analyze file sources for better debugging
            const generatedFilePaths = new Set(Object.keys(state.generatedFilesMap || {}));
            const templateFiles = requestedFiles.filter(f => !generatedFilePaths.has(f.filePath));
            const customizedFiles = requestedFiles.filter(f => generatedFilePaths.has(f.filePath));

            logger.info("📦 [GET_FILES_TO_DEPLOY] Retrieved all files - breakdown", {
                totalFilesCount: requestedFiles.length,
                templateFilesCount: templateFiles.length,
                customizedFilesCount: customizedFiles.length,
                templateFilePaths: templateFiles.map(f => f.filePath).slice(0, 20), // Log first 20 template files
                customizedFilePaths: customizedFiles.map(f => f.filePath).slice(0, 20), // Log first 20 customized files
                allFilePaths: requestedFiles.map(f => f.filePath) // Log all file paths for full visibility
            });
        } else {
            // When specific files are requested, log them
            logger.info("📦 [GET_FILES_TO_DEPLOY] Using requested files only", {
                requestedFilesCount: requestedFiles.length,
                requestedFilePaths: requestedFiles.map(f => f.filePath)
            });
        }

        logger.info("🔍 [GET_FILES_TO_DEPLOY] Filtering backend read-only files", {
            totalFilesBeforeFilter: requestedFiles.length,
            filePaths: requestedFiles.map(f => f.filePath)
        });

        // Filter out backend read-only files - agent can only deploy frontend files
        const backendFiles: string[] = [];
        const frontendFiles = requestedFiles.filter(file => {
            if (isBackendReadOnlyFile(file.filePath)) {
                backendFiles.push(file.filePath);
                logger.warn(`🚫 [GET_FILES_TO_DEPLOY] Skipping read-only backend file from deployment: ${file.filePath}`);
                return false;
            }
            return true;
        });

        // Analyze frontend files by source
        const frontendGeneratedFilePaths = new Set(Object.keys(state.generatedFilesMap || {}));
        const frontendTemplateFiles = frontendFiles.filter(f => !frontendGeneratedFilePaths.has(f.filePath));
        const frontendCustomizedFiles = frontendFiles.filter(f => frontendGeneratedFilePaths.has(f.filePath));

        logger.info("✅ [GET_FILES_TO_DEPLOY] File filtering complete", {
            totalFilesBeforeFilter: requestedFiles.length,
            frontendFilesCount: frontendFiles.length,
            backendFilesFiltered: backendFiles.length,
            frontendTemplateFilesCount: frontendTemplateFiles.length,
            frontendCustomizedFilesCount: frontendCustomizedFiles.length,
            backendFilesFilteredList: backendFiles,
            frontendFilePaths: frontendFiles.map(f => f.filePath),
            frontendTemplateFilePaths: frontendTemplateFiles.map(f => f.filePath).slice(0, 30), // Log first 30
            frontendCustomizedFilePaths: frontendCustomizedFiles.map(f => f.filePath).slice(0, 30) // Log first 30
        });

        return frontendFiles.map(file => ({
            filePath: file.filePath,
            fileContents: file.fileContents
        }));
    }

    /**
     * Deploy to Cloudflare Workers
     * Returns deployment URL and deployment ID for database updates
     */
    async deployToCloudflare(callbacks?: CloudflareDeploymentCallbacks): Promise<{ deploymentUrl: string | null; deploymentId?: string }> {
        const state = this.getState();
        const logger = this.getLog();
        const client = this.getClient();

        await this.waitForPreview();

        callbacks?.onStarted?.({
            message: 'Starting deployment to Cloudflare Workers...',
            instanceId: state.sandboxInstanceId ?? ''
        });

        logger.info('Starting Cloudflare deployment');

        // Check if we have generated files
        if (!state.generatedFilesMap || Object.keys(state.generatedFilesMap).length === 0) {
            logger.error('No generated files available for deployment');
            callbacks?.onError?.({
                message: 'Deployment failed: No generated code available',
                instanceId: state.sandboxInstanceId ?? '',
                error: 'No files have been generated yet'
            });
            return { deploymentUrl: null };
        }

        // Ensure sandbox instance exists - return null to trigger agent orchestration
        if (!state.sandboxInstanceId) {
            logger.info('No sandbox instance ID available');
            return { deploymentUrl: null };
        }

        logger.info('Prerequisites met, initiating deployment', {
            sandboxInstanceId: state.sandboxInstanceId,
            fileCount: Object.keys(state.generatedFilesMap).length
        });

        // Fetch the app record to get custom subdomain (if set)
        let customSubdomain: string | undefined;
        try {
            const { AppService } = await import('../../../database/services/AppService');
            const appService = new AppService(this.env);
            const appId = state.inferenceContext?.agentId;
            if (appId) {
                const app = await appService.getAppDetails(appId);
                if (app?.customSubdomain) {
                    customSubdomain = app.customSubdomain;
                    logger.info('Using custom subdomain for deployment', { customSubdomain });
                }
            }
        } catch (error) {
            logger.warn('Could not fetch app record for custom subdomain, using default', { error });
        }

        // Deploy to Cloudflare (pass customSubdomain if available)
        const deploymentResult = await client.deployToCloudflareWorkers(
            state.sandboxInstanceId,
            customSubdomain
        );

        logger.info('Deployment result:', deploymentResult);

        if (!deploymentResult || !deploymentResult.success) {
            logger.error('Deployment failed', {
                message: deploymentResult?.message,
                error: deploymentResult?.error
            });

            // Check for preview expired error
            if (deploymentResult?.error?.includes('Failed to read instance metadata') ||
                deploymentResult?.error?.includes(`/bin/sh: 1: cd: can't cd to i-`)) {
                logger.error('Deployment sandbox died - preview expired');
                callbacks?.onPreviewExpired?.();
            } else {
                callbacks?.onError?.({
                    message: `Deployment failed: ${deploymentResult?.message || 'Unknown error'}`,
                    instanceId: state.sandboxInstanceId ?? '',
                    error: deploymentResult?.error || 'Unknown deployment error'
                });
            }

            return { deploymentUrl: null };
        }

        const deploymentUrl = deploymentResult.deployedUrl;
        const deploymentId = deploymentResult.deploymentId;

        logger.info('Cloudflare deployment completed successfully', {
            deploymentUrl,
            deploymentId,
            message: deploymentResult.message
        });

        callbacks?.onCompleted?.({
            message: deploymentResult.message || 'Successfully deployed to Cloudflare Workers!',
            instanceId: state.sandboxInstanceId ?? '',
            deploymentUrl: deploymentUrl || ''
        });

        return {
            deploymentUrl: deploymentUrl || null,
            deploymentId: deploymentId
        };
    }

}
