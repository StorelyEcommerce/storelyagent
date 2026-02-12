import {
    // Template types
    TemplateListResponse,
    TemplateDetailsResponse,

    GetInstanceResponse,
    BootstrapStatusResponse,
    ShutdownResponse,

    // File operation types
    WriteFilesRequest,
    WriteFilesResponse,
    GetFilesResponse,

    ExecuteCommandsResponse,

    // Error management types
    RuntimeErrorResponse,
    ClearErrorsResponse,

    // Analysis types
    StaticAnalysisResponse,

    // Deployment types
    DeploymentResult,
    BootstrapResponse,

    GetLogsResponse,
    ListInstancesResponse,
    TemplateDetails,
    TemplateInfo,
    InstanceCreationRequest,
} from './sandboxTypes';

import { createObjectLogger, StructuredLogger } from '../../logger';
import { env } from 'cloudflare:workers'
import { ZipExtractor } from './zipExtractor';
import { FileTreeBuilder } from './fileTreeBuilder';
import { DeploymentTarget } from 'worker/agents/core/types';

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

export interface TemplateInfo {
    name: string;
    language?: string;
    frameworks?: string[];
    description: {
        selection: string;
        usage: string;
    };
}

const templateDetailsCache: Record<string, TemplateDetails> = {};

/**
 * Clear the template details cache. Call this when templates are updated in R2.
 */
export function clearTemplateCache(templateName?: string) {
    if (templateName) {
        delete templateDetailsCache[templateName];
        console.log(`Template cache cleared for: ${templateName}`);
    } else {
        for (const key of Object.keys(templateDetailsCache)) {
            delete templateDetailsCache[key];
        }
        console.log('All template caches cleared');
    }
}

/**
 * Abstract base class providing complete RunnerService API compatibility
 * All implementations MUST support every method defined here
*/
export abstract class BaseSandboxService {
    protected logger: StructuredLogger;
    protected sandboxId: string;

    constructor(sandboxId: string) {
        this.logger = createObjectLogger(this, 'BaseSandboxService');
        this.sandboxId = sandboxId;
    }

    // Any async startup tasks should be done here
    abstract initialize(): Promise<void>;

    // ==========================================
    // TEMPLATE MANAGEMENT (Required)
    // ==========================================

    /**
     * List all available templates
     * Returns: { success: boolean, templates: [...], count: number, error?: string }
     */
    static async listTemplates(): Promise<TemplateListResponse> {
        try {
            const response = await env.TEMPLATES_BUCKET.get('template_catalog.json');
            if (response === null) {
                throw new Error(`Failed to fetch template catalog: Template catalog not found`);
            }

            const templates = await response.json() as TemplateInfo[];

            // For now, just filter out *next* templates
            const filteredTemplates = templates.filter(t => !t.name.includes('next'));

            return {
                success: true,
                templates: filteredTemplates.map(t => ({
                    name: t.name,
                    language: t.language,
                    frameworks: t.frameworks || [],
                    description: t.description,
                    disabled: t.disabled ?? false,
                    projectType: t.projectType || 'app',
                    renderMode: t.renderMode,
                    slideDirectory: t.slideDirectory,
                })),
                count: filteredTemplates.length
            };
        } catch (error) {
            return {
                success: false,
                templates: [],
                count: 0,
                error: `Failed to fetch templates: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    /**
     * Get details for a specific template - fully in-memory, no sandbox operations
     * Downloads zip from R2, extracts in memory, and returns all files with metadata
     * Returns: { success: boolean, templateDetails?: {...}, error?: string }
     */
    static async getTemplateDetails(templateName: string, downloadDir?: string): Promise<TemplateDetailsResponse> {
        try {
            if (templateDetailsCache[templateName]) {
                const cached = templateDetailsCache[templateName];
                const cachedPackageJson = cached.deps;
                console.log(`\n${'='.repeat(60)}`);
                console.log(`📋 USING CACHED TEMPLATE: ${templateName}`);
                console.log(`${'='.repeat(60)}`);
                console.log(`📦 CACHED NAME: ${cachedPackageJson?.name || 'N/A'}`);
                console.log(`📦 CACHED DEV SCRIPT: ${(cachedPackageJson as any)?.scripts?.dev || 'N/A'}`);
                console.log(`📁 CACHED FILES COUNT: ${Object.keys(cached.allFiles || {}).length}`);
                console.log(`📁 HAS WORKER DIR: ${Object.keys(cached.allFiles || {}).some(f => f.startsWith('worker/'))}`);
                console.log(`${'='.repeat(60)}\n`);
                return {
                    success: true,
                    templateDetails: cached
                };
            }
            // Download template zip from R2
            const downloadUrl = downloadDir ? `${downloadDir}/${templateName}.zip` : `${templateName}.zip`;
            console.log(`📥 TEMPLATE DOWNLOAD: Looking for "${downloadUrl}" in R2 bucket`);

            const r2Object = await env.TEMPLATES_BUCKET.get(downloadUrl);

            if (!r2Object) {
                console.log(`❌ TEMPLATE NOT FOUND: "${downloadUrl}" does not exist in bucket`);
                throw new Error(`Template '${templateName}' not found in bucket`);
            }

            const zipData = await r2Object.arrayBuffer();
            console.log(`✅ TEMPLATE DOWNLOADED: ${zipData.byteLength} bytes`);

            // Extract all files in memory
            const allFiles = ZipExtractor.extractFiles(zipData);
            console.log(`📂 EXTRACTED FILES: ${allFiles.length} files from zip`);

            // Log first 10 file paths for debugging
            const filePaths = allFiles.slice(0, 10).map(f => f.filePath);
            console.log(`📂 SAMPLE FILES: ${filePaths.join(', ')}${allFiles.length > 10 ? '...' : ''}`);

            // Build file tree
            const fileTree = FileTreeBuilder.buildFromTemplateFiles(allFiles, { rootPath: '.' });

            // Extract package.json (full content for scripts, dependencies, etc.)
            const packageJsonFile = allFiles.find(f => f.filePath === 'package.json');
            console.log(`📦 PACKAGE.JSON FOUND: ${packageJsonFile ? 'YES' : 'NO'}`);
            if (packageJsonFile) {
                console.log(`📦 PACKAGE.JSON PATH: "${packageJsonFile.filePath}"`);
                console.log(`📦 PACKAGE.JSON SIZE: ${packageJsonFile.fileContents.length} chars`);
            }

            const packageJson = packageJsonFile ? JSON.parse(packageJsonFile.fileContents) : null;
            if (packageJson) {
                console.log(`📦 PACKAGE.JSON NAME: ${packageJson.name || 'N/A'}`);
                console.log(`📦 PACKAGE.JSON SCRIPTS: ${Object.keys(packageJson.scripts || {}).join(', ') || 'NONE'}`);
            }

            // Parse metadata files
            const dontTouchFile = allFiles.find(f => f.filePath === '.donttouch_files.json');
            const dontTouchFiles = dontTouchFile ? JSON.parse(dontTouchFile.fileContents) : [];

            const redactedFile = allFiles.find(f => f.filePath === '.redacted_files.json');
            const redactedFiles = redactedFile ? JSON.parse(redactedFile.fileContents) : [];

            const importantFile = allFiles.find(f => f.filePath === '.important_files.json');
            const importantFiles = importantFile ? JSON.parse(importantFile.fileContents) : [];

            // Get template info from catalog
            const catalogResponse = await BaseSandboxService.listTemplates();
            const catalogInfo = catalogResponse.success
                ? catalogResponse.templates.find(t => t.name === templateName)
                : null;

            // Remove metadata files and convert to map for efficient lookups
            const filteredFiles = allFiles.filter(f =>
                !f.filePath.startsWith('.') ||
                (!f.filePath.endsWith('.json') && !f.filePath.startsWith('.git'))
            );

            // Convert array to map: filePath -> fileContents
            const filesMap: Record<string, string> = {};
            for (const file of filteredFiles) {
                filesMap[file.filePath] = file.fileContents;
            }

            const templateDetails: TemplateDetails = {
                name: templateName,
                description: {
                    selection: catalogInfo?.description.selection || '',
                    usage: catalogInfo?.description.usage || ''
                },
                disabled: catalogInfo?.disabled ?? false,
                fileTree,
                allFiles: filesMap,
                language: catalogInfo?.language,
                deps: packageJson,
                importantFiles,
                dontTouchFiles,
                redactedFiles,
                frameworks: catalogInfo?.frameworks || []
            };

            templateDetailsCache[templateName] = templateDetails;

            // Comprehensive debug logging for template verification
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🆕 FRESH TEMPLATE LOADED FROM R2: ${templateName}`);
            console.log(`${'='.repeat(60)}`);
            console.log(`📦 TEMPLATE NAME: ${packageJson?.name || 'N/A'}`);
            console.log(`📦 TEMPLATE VERSION: ${packageJson?.version || 'N/A'}`);
            console.log(`📦 DEV SCRIPT: ${packageJson?.scripts?.dev || 'N/A'}`);
            console.log(`📦 BUILD SCRIPT: ${packageJson?.scripts?.build || 'N/A'}`);
            console.log(`📦 POSTINSTALL: ${packageJson?.scripts?.postinstall || 'N/A'}`);
            console.log(`📦 DEPENDENCIES: ${Object.keys(packageJson?.dependencies || {}).join(', ') || 'NONE'}`);
            console.log(`📦 DEV DEPENDENCIES: ${Object.keys(packageJson?.devDependencies || {}).slice(0, 5).join(', ')}${Object.keys(packageJson?.devDependencies || {}).length > 5 ? '...' : ''}`);
            console.log(`📁 TOTAL FILES: ${Object.keys(filesMap).length}`);
            console.log(`📁 HAS WORKER DIR: ${Object.keys(filesMap).some(f => f.startsWith('worker/'))}`);
            console.log(`📁 HAS API-WORKER DIR: ${Object.keys(filesMap).some(f => f.startsWith('api-worker/'))}`);
            console.log(`${'='.repeat(60)}\n`);

            return {
                success: true,
                templateDetails
            };
        } catch (error) {
            return {
                success: false,
                error: `Failed to get template details: ${error instanceof Error ? error.message : 'Unknown error'}`
            };
        }
    }

    // ==========================================
    // INSTANCE LIFECYCLE (Required)
    // ==========================================

    /**
     * Create a new instance from a template
     * Returns: { success: boolean, instanceId?: string, error?: string }
     * @param options - Instance creation options
     */
    abstract createInstance(
        options: InstanceCreationRequest
    ): Promise<BootstrapResponse>;

    /**
     * List all instances across all sessions
     * Returns: { success: boolean, instances: [...], count: number, error?: string }
     */
    abstract listAllInstances(): Promise<ListInstancesResponse>;

    /**
     * Get detailed information about an instance
     * Returns: { success: boolean, instance?: {...}, error?: string }
     */
    abstract getInstanceDetails(instanceId: string): Promise<GetInstanceResponse>;

    /**
     * Get current status of an instance
     * Returns: { success: boolean, pending: boolean, message?: string, previewURL?: string, error?: string }
     */
    abstract getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse>;

    /**
     * Shutdown and cleanup an instance
     * Returns: { success: boolean, message?: string, error?: string }
     */
    abstract shutdownInstance(instanceId: string): Promise<ShutdownResponse>;

    // ==========================================
    // FILE OPERATIONS (Required)
    // ==========================================

    /**
     * Write multiple files to an instance
     * Returns: { success: boolean, message?: string, results: [...], error?: string }
     */
    abstract writeFiles(instanceId: string, files: WriteFilesRequest['files'], commitMessage?: string): Promise<WriteFilesResponse>;

    /**
     * Read specific files from an instance
     * Returns: { success: boolean, files: [...], errors?: [...], error?: string }
     */
    abstract getFiles(instanceId: string, filePaths?: string[]): Promise<GetFilesResponse>;

    abstract getLogs(instanceId: string, onlyRecent?: boolean, durationSeconds?: number): Promise<GetLogsResponse>;

    // ==========================================
    // COMMAND EXECUTION (Required)
    // ==========================================

    /**
     * Execute multiple commands sequentially with optional timeout
     * Returns: { success: boolean, results: [...], message?: string, error?: string }
     */
    abstract executeCommands(instanceId: string, commands: string[], timeout?: number): Promise<ExecuteCommandsResponse>;

    abstract updateProjectName(instanceId: string, projectName: string): Promise<boolean>;

    // ==========================================
    // ERROR MANAGEMENT (Required)
    // ==========================================

    /**
     * Get all runtime errors from an instance
     * Returns: { success: boolean, errors: [...], hasErrors: boolean, error?: string }
     */
    abstract getInstanceErrors(instanceId: string, clear?: boolean): Promise<RuntimeErrorResponse>;

    /**
     * Clear all runtime errors from an instance
     * Returns: { success: boolean, message?: string, error?: string }
     */
    abstract clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse>;

    // ==========================================
    // CODE ANALYSIS & FIXING (Required)
    // ==========================================

    /**
     * Run static analysis (linting + type checking) on instance code
     * Returns: { success: boolean, lint: {...}, typecheck: {...}, error?: string }
     */
    abstract runStaticAnalysisCode(instanceId: string, lintFiles?: string[]): Promise<StaticAnalysisResponse>;

    // ==========================================
    // DEPLOYMENT (Required)
    // ==========================================

    /**
     * Deploy instance to Cloudflare Workers
     * Returns: { success: boolean, message: string, deployedUrl?: string, deploymentId?: string, error?: string }
     * @param instanceId - The sandbox instance ID
     * @param customSubdomain - Optional custom subdomain to use instead of default project name
     */
    abstract deployToCloudflareWorkers(instanceId: string, customSubdomain?: string): Promise<DeploymentResult>;

    // ==========================================
    // GITHUB INTEGRATION (Required)
    // ==========================================

}
