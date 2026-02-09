/**
 * Manus API Types
 * 
 * TypeScript interfaces for the Manus AI API.
 * Documentation: https://open.manus.im/docs
 */

// ============================================================================
// Task Creation
// ============================================================================

/**
 * Agent profile options for Manus tasks
 */
export type ManusAgentProfile = 'manus-1.6' | 'manus-1.6-lite' | 'manus-1.6-max';

/**
 * Task mode options
 */
export type ManusTaskMode = 'chat' | 'adaptive' | 'agent';

/**
 * Attachment types for task creation
 */
export interface ManusFileIdAttachment {
    type: 'file_id';
    file_id: string;
}

export interface ManusUrlAttachment {
    type: 'url';
    url: string;
}

export interface ManusBase64Attachment {
    type: 'base64';
    data: string;
    filename: string;
    media_type: string;
}

export type ManusAttachment = ManusFileIdAttachment | ManusUrlAttachment | ManusBase64Attachment;

/**
 * Request body for creating a new task
 */
export interface ManusCreateTaskRequest {
    /** The task prompt or instruction for the Manus agent */
    prompt: string;
    /** Agent profile to use: manus-1.6, manus-1.6-lite, or manus-1.6-max */
    agentProfile?: ManusAgentProfile;
    /** Array of file/image attachments */
    attachments?: ManusAttachment[];
    /** Task mode: chat, adaptive, or agent */
    task_mode?: ManusTaskMode;
    /** List of connector IDs to enable for this task */
    connectors?: string[];
    /** Whether to hide this task from the Manus webapp task list */
    hide_in_task_list?: boolean;
    /** Whether to make the chat publicly accessible */
    create_shareable_link?: boolean;
    /** For continuing existing tasks (multi-turn) */
    task_id?: string;
    /** Locale setting (e.g., "en-US", "zh-CN") */
    locale?: string;
    /** ID of the project to associate this task with */
    project_id?: string;
    /** Enable interactive mode for follow-up questions */
    interactive_mode?: boolean;
}

/**
 * Response from creating a new task
 */
export interface ManusCreateTaskResponse {
    /** Unique identifier for the task */
    task_id: string;
    /** Title of the task */
    task_title: string;
    /** URL to view the task in Manus webapp */
    task_url: string;
    /** Optional publicly accessible link (if create_shareable_link was true) */
    share_url?: string;
}

// ============================================================================
// Task Status & Retrieval
// ============================================================================

/**
 * Task status values
 */
export type ManusTaskStatusValue = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Content types in task output
 */
export interface ManusOutputText {
    type: 'output_text';
    text: string;
}

export interface ManusOutputFile {
    type: 'output_file';
    fileUrl: string;
    fileName: string;
    mimeType?: string;
}

export type ManusOutputContent = ManusOutputText | ManusOutputFile;

/**
 * Individual output message in task result
 */
export interface ManusTaskOutput {
    id: string;
    status: string;
    role: 'user' | 'assistant';
    type: string;
    content: ManusOutputContent[];
}

/**
 * Full task status response
 */
export interface ManusTaskStatus {
    /** Unique identifier for the task */
    id: string;
    /** Always "task" */
    object: string;
    /** Unix timestamp (seconds) when the task was created */
    created_at: number;
    /** Unix timestamp (seconds) when the task was last updated */
    updated_at: number;
    /** Current status of the task */
    status: ManusTaskStatusValue;
    /** Error message if the task failed */
    error?: string;
    /** Details about why the task is incomplete */
    incomplete_details?: string;
    /** The original prompt/instructions for the task */
    instructions?: string;
    /** Maximum output tokens limit */
    max_output_tokens?: number;
    /** Model used for the task */
    model?: string;
    /** Custom metadata key-value pairs */
    metadata?: Record<string, unknown>;
    /** Array of task messages (conversation history) */
    output: ManusTaskOutput[];
    /** User's preferred locale */
    locale?: string;
    /** Credits consumed by this task */
    credit_usage?: number;
}

// ============================================================================
// File Management
// ============================================================================

/**
 * Request to create a file record
 */
export interface ManusCreateFileRequest {
    /** Name of the file to upload */
    filename: string;
}

/**
 * Response from creating a file record
 */
export interface ManusCreateFileResponse {
    /** Unique identifier for the file */
    id: string;
    /** Always "file" */
    object: string;
    /** Name of the file */
    filename: string;
    /** Initial status is "pending" */
    status: string;
    /** Presigned S3 URL for uploading the file content (PUT request) */
    upload_url: string;
    /** ISO 8601 timestamp when the upload URL expires */
    upload_expires_at: string;
    /** ISO 8601 timestamp when the file record was created */
    created_at: string;
}

// ============================================================================
// Polling Configuration
// ============================================================================

/**
 * Options for polling task completion
 */
export interface ManusPollingOptions {
    /** Interval between polls in milliseconds (default: 5000) */
    pollIntervalMs?: number;
    /** Maximum time to wait in milliseconds (default: 300000 = 5 minutes) */
    timeoutMs?: number;
    /** Callback for progress updates */
    onProgress?: (status: ManusTaskStatus) => void;
    /** Optional abort signal for cancellation */
    abortSignal?: AbortSignal;
}

// ============================================================================
// Code Generation Specific Types
// ============================================================================

/**
 * Parsed file from Manus output
 */
export interface ManusGeneratedFile {
    /** File path relative to project root */
    path: string;
    /** File content */
    content: string;
    /** Optional purpose/description */
    purpose?: string;
}

/**
 * Result from Manus code generation
 */
export interface ManusCodeGenerationResult {
    /** Whether the generation was successful */
    success: boolean;
    /** Generated files */
    files?: ManusGeneratedFile[];
    /** Raw text output from Manus */
    rawOutput?: string;
    /** Error message if failed */
    error?: string;
    /** Task ID for reference */
    taskId?: string;
    /** URL to view the task */
    taskUrl?: string;
}
