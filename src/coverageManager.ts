import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages coverage file lifecycle with proper cleanup
 * Tracks temporary coverage files and ensures they are deleted
 */
export class CoverageManager implements vscode.Disposable {
    private trackedFiles: Set<string> = new Set();
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Register a coverage file for tracking and cleanup
     * @param filePath Path to the coverage file
     */
    public registerCoverageFile(filePath: string): void {
        if (!filePath) {
            return;
        }

        const normalizedPath = path.normalize(filePath);
        this.trackedFiles.add(normalizedPath);
        // DEV: Uncomment for debugging
        // this.outputChannel.appendLine(`[CoverageManager] Registered coverage file: ${normalizedPath}`);
    }

    /**
     * Generate a unique coverage file path for a test run
     * @param workspaceRoot Workspace root directory
     * @param suite Optional suite name for better organization
     * @param dockerWorkdir Optional Docker working directory for path conversion
     * @returns Unique coverage file path (container path if Docker is used, host path otherwise)
     */
    public generateCoverageFilePath(workspaceRoot: string, suite?: string, dockerWorkdir?: string): string {
        const timestamp = Date.now();
        const suitePrefix = suite ? `${suite}-` : '';
        const fileName = `coverage-${suitePrefix}${timestamp}.xml`;
        
        // Use Codeception's default output directory if it exists, otherwise use workspace root
        const outputDir = path.join(workspaceRoot, 'tests', '_output');
        const coverageDir = fs.existsSync(outputDir) ? outputDir : workspaceRoot;
        
        // Generate host path first
        const hostPath = path.join(coverageDir, fileName);
        
        // If Docker is being used, convert to container path
        let coveragePath = hostPath;
        if (dockerWorkdir) {
            // Calculate relative path from workspace root
            const relativePath = path.relative(workspaceRoot, hostPath);
            // Convert to container path using POSIX separators (Docker uses Linux paths)
            coveragePath = path.posix.join(dockerWorkdir, relativePath.split(path.sep).join(path.posix.sep));
            // DEV: Uncomment for debugging
            // this.outputChannel.appendLine(`[CoverageManager] Docker path conversion: ${hostPath} -> ${coveragePath}`);
        }
        
        // Register the HOST path for cleanup (we need to clean up the file on the host)
        this.registerCoverageFile(hostPath);
        
        // Return the appropriate path (container path for command, host path for cleanup)
        return coveragePath;
    }
    
    /**
     * Get the host path for a coverage file (for cleanup purposes)
     * When using Docker, the command uses container paths but cleanup needs host paths
     * @param workspaceRoot Workspace root directory
     * @param containerPath Container path to convert back to host path
     * @param dockerWorkdir Docker working directory
     * @returns Host file system path
     */
    public getHostPath(workspaceRoot: string, containerPath: string, dockerWorkdir?: string): string {
        if (!dockerWorkdir) {
            return containerPath;
        }
        
        // Convert container path back to host path
        const relativePath = path.posix.relative(dockerWorkdir, containerPath);
        const hostPath = path.join(workspaceRoot, relativePath.split(path.posix.sep).join(path.sep));
        
        return hostPath;
    }

    /**
     * Clean up a single coverage file
     * Handles errors gracefully and logs them
     * @param filePath Path to the coverage file to delete
     */
    public async cleanupCoverageFile(filePath: string): Promise<void> {
        if (!filePath) {
            return;
        }

        const normalizedPath = path.normalize(filePath);
        
        try {
            // Check if file exists before attempting deletion
            if (!fs.existsSync(normalizedPath)) {
                // File already deleted or doesn't exist - that's fine
                this.trackedFiles.delete(normalizedPath);
                return;
            }

            // Attempt to delete the file
            await fs.promises.unlink(normalizedPath);
            this.trackedFiles.delete(normalizedPath);
            // DEV: Uncomment for debugging
            // this.outputChannel.appendLine(`[CoverageManager] Cleaned up coverage file: ${normalizedPath}`);

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            const errorCode = (error as NodeJS.ErrnoException)?.code;

            // Handle specific error cases gracefully
            if (errorCode === 'ENOENT') {
                // File doesn't exist - already cleaned up or never created
                this.trackedFiles.delete(normalizedPath);
                return;
            }

            if (errorCode === 'EACCES' || errorCode === 'EPERM') {
                // Permission denied - log warning but don't fail
                this.outputChannel.appendLine(`WARNING: Permission denied deleting coverage file: ${normalizedPath}`);
                this.trackedFiles.delete(normalizedPath);
                return;
            }

            // Other errors - log but don't throw
            this.outputChannel.appendLine(`ERROR cleaning up coverage file ${normalizedPath}: ${errorMessage}`);
            // Keep file in tracked set so we can try again later
        }
    }

    /**
     * Clean up all tracked coverage files
     * Called on extension deactivation or shutdown
     */
    public async cleanupAllCoverageFiles(): Promise<void> {
        if (this.trackedFiles.size === 0) {
            return;
        }

        const filesToCleanup = Array.from(this.trackedFiles);
        const cleanupPromises = filesToCleanup.map(file => this.cleanupCoverageFile(file));

        try {
            await Promise.allSettled(cleanupPromises);
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR during coverage cleanup: ${errorMessage}`);
        }
    }

    /**
     * Get list of currently tracked coverage files
     * Useful for debugging
     */
    public getTrackedFiles(): string[] {
        return Array.from(this.trackedFiles);
    }

    /**
     * Dispose of the coverage manager
     * Cleans up all tracked files
     */
    public async dispose(): Promise<void> {
        await this.cleanupAllCoverageFiles();
        this.trackedFiles.clear();
    }
}

