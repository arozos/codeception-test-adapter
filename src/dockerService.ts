import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DockerContainer {
    id: string;
    name: string;
    image: string;
    status: string;
}

/**
 * Service for interacting with Docker containers
 */
export class DockerService {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Check if Docker is available on the system
     */
    public async isDockerAvailable(): Promise<{ available: boolean; error?: string }> {
        try {
            // Try to get Docker version to verify it's installed and accessible
            const { stdout, stderr } = await execAsync('docker --version', { timeout: 5000 });
            
            if (stdout && stdout.toLowerCase().includes('docker version')) {
                return { available: true };
            }
            
            const errorMsg = 'Docker command executed but version not recognized';
            return { available: false, error: errorMsg };
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            
            // Determine specific error type
            if (errorMessage.includes('command not found') || 
                errorMessage.includes('not recognized') ||
                errorMessage.includes('ENOENT')) {
                return { 
                    available: false, 
                    error: 'Docker is not installed or not in PATH. Please install Docker Desktop or Docker Engine.' 
                };
            }
            
            if (errorMessage.includes('Cannot connect to the Docker daemon') ||
                errorMessage.includes('Is the docker daemon running')) {
                return { 
                    available: false, 
                    error: 'Docker daemon is not running. Please start Docker Desktop or the Docker service.' 
                };
            }
            
            if (errorMessage.includes('permission denied')) {
                return { 
                    available: false, 
                    error: 'Permission denied accessing Docker. You may need to add your user to the docker group or run with appropriate permissions.' 
                };
            }
            
            return { 
                available: false, 
                error: `Docker check failed: ${errorMessage}` 
            };
        }
    }

    /**
     * List all running Docker containers
     */
    public async listRunningContainers(): Promise<DockerContainer[]> {
        try {
            // Use docker ps with custom format to get structured data
            const { stdout, stderr } = await execAsync(
                'docker ps --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"',
                { timeout: 10000 }
            );

            if (!stdout || !stdout.trim()) {
                return [];
            }

            const containers = this.parseDockerPsOutput(stdout);
            
            return containers;
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR: Failed to list Docker containers: ${errorMessage}`);
            
            // Provide specific error messages
            if (errorMessage.includes('command not found') || 
                errorMessage.includes('not recognized') ||
                errorMessage.includes('ENOENT')) {
                throw new Error('Docker command not found. Please ensure Docker is installed and available in your PATH.');
            }
            
            if (errorMessage.includes('Cannot connect to the Docker daemon') ||
                errorMessage.includes('Is the docker daemon running')) {
                throw new Error('Cannot connect to Docker daemon. Please ensure Docker Desktop or Docker service is running.');
            }
            
            if (errorMessage.includes('permission denied')) {
                throw new Error('Permission denied accessing Docker. You may need to add your user to the docker group.');
            }
            
            throw new Error(`Failed to list Docker containers: ${errorMessage}`);
        }
    }

    /**
     * Parse docker ps output into structured container data
     */
    private parseDockerPsOutput(output: string): DockerContainer[] {
        const lines = output.trim().split('\n');
        const containers: DockerContainer[] = [];

        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            // Format: ID\tNAMES\tIMAGE\tSTATUS
            const parts = line.split('\t');
            
            if (parts.length >= 4) {
                containers.push({
                    id: parts[0].trim(),
                    name: parts[1].trim(),
                    image: parts[2].trim(),
                    status: parts[3].trim(),
                });
            }
        }

        return containers;
    }

    /**
     * Validate that a container exists and is running
     */
    public async validateContainer(containerIdOrName: string): Promise<boolean> {
        try {
            const { stdout } = await execAsync(
                `docker ps --filter "id=${containerIdOrName}" --filter "name=${containerIdOrName}" --format "{{.ID}}"`
            );
            
            return stdout.trim().length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get the current working directory inside a container
     * This helps detect where the project is mounted inside the container
     */
    public async getContainerWorkingDirectory(containerIdOrName: string, hostWorkspacePath: string): Promise<string> {
        try {
            // Try to find the workspace path inside the container
            // First, try using the host path (works if paths are the same, e.g., WSL)
            const { stdout: testPath } = await execAsync(
                `docker exec ${containerIdOrName} test -d "${hostWorkspacePath}" && echo "exists" || echo "not found"`,
                { timeout: 5000 }
            );

            if (testPath.trim() === 'exists') {
                return hostWorkspacePath;
            }

            // If host path doesn't exist, try to find it via pwd in common locations
            // Execute pwd in the container to see the default working directory
            const { stdout: pwd } = await execAsync(
                `docker exec ${containerIdOrName} pwd`,
                { timeout: 5000 }
            );

            const containerPwd = pwd.trim();

            // Check if codeception.yml exists in the pwd location
            const { stdout: hasCodeception } = await execAsync(
                `docker exec ${containerIdOrName} test -f "${containerPwd}/codeception.yml" && echo "exists" || echo "not found"`,
                { timeout: 5000 }
            );

            if (hasCodeception.trim() === 'exists') {
                return containerPwd;
            }

            // Try common mount points
            const commonPaths = ['/var/www/html', '/app', '/application', '/var/www', '/usr/src/app'];
            
            for (const path of commonPaths) {
                try {
                    const { stdout: exists } = await execAsync(
                        `docker exec ${containerIdOrName} test -f "${path}/codeception.yml" && echo "exists" || echo "not found"`,
                        { timeout: 5000 }
                    );

                    if (exists.trim() === 'exists') {
                        return path;
                    }
                } catch (e) {
                    // Continue to next path
                }
            }

            // If nothing found, return the container's pwd as fallback
            return containerPwd;

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR detecting Docker working directory: ${errorMessage}`);
            return hostWorkspacePath;
        }
    }

    /**
     * Read a file from inside a Docker container
     * This is useful for reading files that may have permission issues when accessed from the host
     * @param containerIdOrName Container ID or name
     * @param containerFilePath Path to the file inside the container
     * @returns File contents as string, or null if file doesn't exist or can't be read
     */
    public async readFileFromContainer(containerIdOrName: string, containerFilePath: string): Promise<string | null> {
        try {
            // First check if file exists in container
            const { stdout: exists } = await execAsync(
                `docker exec ${containerIdOrName} test -f "${containerFilePath}" && echo "exists" || echo "not found"`,
                { timeout: 5000 }
            );

            if (exists.trim() !== 'exists') {
                this.outputChannel.appendLine(`[Docker] File not found in container: ${containerFilePath}`);
                return null;
            }

            // Read file contents using cat
            const { stdout: content } = await execAsync(
                `docker exec ${containerIdOrName} cat "${containerFilePath}"`,
                { timeout: 10000 }
            );

            return content;

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`[Docker] ERROR reading file from container: ${errorMessage}`);
            return null;
        }
    }

    /**
     * Check if a file exists in a Docker container
     * @param containerIdOrName Container ID or name
     * @param containerFilePath Path to the file inside the container
     * @returns true if file exists, false otherwise
     */
    public async fileExistsInContainer(containerIdOrName: string, containerFilePath: string): Promise<boolean> {
        try {
            const { stdout } = await execAsync(
                `docker exec ${containerIdOrName} test -f "${containerFilePath}" && echo "exists" || echo "not found"`,
                { timeout: 5000 }
            );

            return stdout.trim() === 'exists';
        } catch (error) {
            return false;
        }
    }
}

