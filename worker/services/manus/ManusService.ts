/**
 * Manus API Service
 * 
 * Client for interacting with the Manus AI API.
 * Handles task creation, status polling, and result extraction.
 * 
 * Documentation: https://open.manus.im/docs
 */

import { createLogger } from '../../logger';
import {
    ManusCreateTaskRequest,
    ManusCreateTaskResponse,
    ManusTaskStatus,
    ManusPollingOptions,
    ManusCreateFileRequest,
    ManusCreateFileResponse,
} from './ManusTypes';

const logger = createLogger('ManusService');

const MANUS_API_BASE = 'https://api.manus.ai';

/**
 * Service class for interacting with the Manus AI API
 */
export class ManusService {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl: string = MANUS_API_BASE) {
        if (!apiKey) {
            throw new Error('Manus API key is required');
        }
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    /**
     * Create a new task
     */
    async createTask(request: ManusCreateTaskRequest): Promise<ManusCreateTaskResponse> {
        logger.info('Creating Manus task', {
            promptLength: request.prompt.length,
            agentProfile: request.agentProfile,
            taskMode: request.task_mode,
            attachmentCount: request.attachments?.length || 0,
        });

        const response = await fetch(`${this.baseUrl}/v1/tasks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'API_KEY': this.apiKey,
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Manus createTask failed', {
                status: response.status,
                error: errorText
            });
            throw new Error(`Manus API error (${response.status}): ${errorText}`);
        }

        const result = await response.json() as ManusCreateTaskResponse;
        logger.info('Manus task created successfully', {
            taskId: result.task_id,
            taskTitle: result.task_title,
            taskUrl: result.task_url,
        });

        return result;
    }

    /**
     * Get the status of a task
     */
    async getTask(taskId: string): Promise<ManusTaskStatus> {
        const response = await fetch(`${this.baseUrl}/v1/tasks/${taskId}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'API_KEY': this.apiKey,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Manus getTask failed', {
                taskId,
                status: response.status,
                error: errorText
            });
            throw new Error(`Manus API error (${response.status}): ${errorText}`);
        }

        return await response.json() as ManusTaskStatus;
    }

    /**
     * Poll for task completion
     * 
     * Continuously checks task status until it completes, fails, or times out.
     */
    async waitForCompletion(
        taskId: string,
        options: ManusPollingOptions = {}
    ): Promise<ManusTaskStatus> {
        const {
            pollIntervalMs = 5000,
            timeoutMs = 300000, // 5 minutes default
            onProgress,
            abortSignal,
        } = options;

        const startTime = Date.now();
        let pollCount = 0;

        logger.info('Starting Manus task polling', {
            taskId,
            pollIntervalMs,
            timeoutMs
        });

        while (true) {
            // Check for abort
            if (abortSignal?.aborted) {
                logger.info('Manus polling aborted by signal', { taskId });
                throw new Error('Manus task polling aborted');
            }

            // Check for timeout
            const elapsed = Date.now() - startTime;
            if (elapsed >= timeoutMs) {
                logger.error('Manus task polling timed out', {
                    taskId,
                    elapsed,
                    timeoutMs
                });
                throw new Error(`Manus task ${taskId} timed out after ${timeoutMs}ms`);
            }

            pollCount++;
            const status = await this.getTask(taskId);

            logger.debug('Manus task poll', {
                taskId,
                pollCount,
                status: status.status,
                elapsed,
            });

            // Call progress callback
            if (onProgress) {
                onProgress(status);
            }

            // Check if task is complete
            if (status.status === 'completed') {
                logger.info('Manus task completed successfully', {
                    taskId,
                    pollCount,
                    elapsed,
                    creditUsage: status.credit_usage,
                });
                return status;
            }

            if (status.status === 'failed') {
                logger.error('Manus task failed', {
                    taskId,
                    error: status.error,
                    incompleteDetails: status.incomplete_details,
                });
                return status;
            }

            // Wait before next poll
            await this.sleep(pollIntervalMs, abortSignal);
        }
    }

    /**
     * Create a file record and get upload URL
     */
    async createFile(request: ManusCreateFileRequest): Promise<ManusCreateFileResponse> {
        const response = await fetch(`${this.baseUrl}/v1/files`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'API_KEY': this.apiKey,
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Manus API error (${response.status}): ${errorText}`);
        }

        return await response.json() as ManusCreateFileResponse;
    }

    /**
     * Upload file content to the presigned URL
     */
    async uploadFileContent(uploadUrl: string, content: string | Buffer): Promise<void> {
        const response = await fetch(uploadUrl, {
            method: 'PUT',
            body: content,
        });

        if (!response.ok) {
            throw new Error(`File upload failed (${response.status})`);
        }
    }

    /**
     * Create and upload a file in one operation
     * Returns the file ID that can be used as an attachment
     */
    async uploadFile(filename: string, content: string): Promise<string> {
        const fileRecord = await this.createFile({ filename });
        await this.uploadFileContent(fileRecord.upload_url, content);
        return fileRecord.id;
    }

    /**
     * Sleep with abort signal support
     */
    private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, ms);

            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    reject(new Error('Aborted'));
                }, { once: true });
            }
        });
    }
}

/**
 * Create a Manus service instance from environment
 */
export function createManusService(env: Env): ManusService | null {
    if (!env.MANUS_API_KEY) {
        logger.warn('MANUS_API_KEY not configured');
        return null;
    }
    return new ManusService(env.MANUS_API_KEY);
}
