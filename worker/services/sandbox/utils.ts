import { TemplateDetails, TemplateFile } from "./sandboxTypes";

/**
 * Check if a file path is in a read-only backend directory
 * Backend and API server files are read-only and cannot be modified by the agent
 */
export function isBackendReadOnlyFile(filePath: string): boolean {
    // Files in api-worker/ and worker/ directories are read-only
    return filePath.startsWith('api-worker/') || 
           filePath.startsWith('worker/');
}

/**
 * Filter out read-only backend files from a list of file paths
 */
export function filterReadOnlyFiles(filePaths: string[]): string[] {
    return filePaths.filter(path => !isBackendReadOnlyFile(path));
}

export function getTemplateImportantFiles(templateDetails: TemplateDetails, filterRedacted: boolean = true, excludeBackend: boolean = false): TemplateFile[] {
    const { importantFiles, allFiles, redactedFiles } = templateDetails;

    const redactedSet = new Set(redactedFiles);
    const importantSet = new Set(importantFiles);

    const result: TemplateFile[] = [];

    for (const [filePath, fileContents] of Object.entries(allFiles)) {
        // Skip backend files if excludeBackend is true (for write operations only)
        if (excludeBackend && isBackendReadOnlyFile(filePath)) {
            continue;
        }
        
        if (importantFiles.some(pattern => filePath === pattern || filePath.startsWith(pattern))) {
            const contents = filterRedacted && redactedSet.has(filePath) ? 'REDACTED' : fileContents;
            if (contents) result.push({ filePath, fileContents: contents });
        }
    }

    return result;
}

export function getTemplateFiles(templateDetails: TemplateDetails, excludeBackend: boolean = false): TemplateFile[] {
    const files = Object.entries(templateDetails.allFiles).map(([filePath, fileContents]) => ({
        filePath,
        fileContents,
    }));
    
    // Filter out backend files if excludeBackend is true (for write operations only)
    if (excludeBackend) {
        return files.filter(file => !isBackendReadOnlyFile(file.filePath));
    }
    
    return files;
}
