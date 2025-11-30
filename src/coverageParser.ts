import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { FileCoverageData, LineCoverage, CoverageParseResult } from './types';
import { DockerService } from './dockerService';

const parseStringAsync = promisify<string, any, any>(parseString);

/**
 * Parser for Codeception's Clover XML coverage format
 * Handles parsing and conversion to VSCode coverage structures
 */
export class CoverageParser {
    private outputChannel: vscode.OutputChannel;
    private dockerService?: DockerService;

    constructor(outputChannel: vscode.OutputChannel, dockerService?: DockerService) {
        this.outputChannel = outputChannel;
        this.dockerService = dockerService;
    }

    /**
     * Parse Clover XML coverage file and convert to VSCode coverage format
     * @param xmlPath Path to the Clover XML coverage file
     * @param containerPath Optional path inside Docker container (if Docker is enabled)
     * @param container Optional Docker container ID/name
     * @returns Map of file paths to coverage data
     */
    public async parseCloverXml(
        xmlPath: string,
        containerPath?: string,
        container?: string
    ): Promise<Map<string, FileCoverageData>> {
        let fileHandle: fs.promises.FileHandle | null = null;
        let fileStream: fs.ReadStream | null = null;

        try {
            let xmlContent: string | null = null;

            // If Docker is enabled and we have container info, try reading from container first
            if (this.dockerService && container && containerPath) {
                this.outputChannel.appendLine(`[CoverageParser] Attempting to read coverage XML from Docker container: ${containerPath}`);
                xmlContent = await this.dockerService.readFileFromContainer(container, containerPath);
                
                if (xmlContent) {
                    this.outputChannel.appendLine(`[CoverageParser] Successfully read coverage XML from Docker container`);
                }
            }

            // Fall back to reading from host filesystem
            if (!xmlContent) {
                // Check if file exists on host
                if (!fs.existsSync(xmlPath)) {
                    this.outputChannel.appendLine(`WARNING: Coverage file not found: ${xmlPath}`);
                    return new Map();
                }

                // Read XML file from host
                xmlContent = await fs.promises.readFile(xmlPath, 'utf-8');
            }
            
            if (!xmlContent || xmlContent.trim().length === 0) {
                this.outputChannel.appendLine(`WARNING: Coverage file is empty: ${xmlPath}`);
                return new Map();
            }

            // Validate XML format - check for Clover XML structure
            if (!xmlContent.includes('<coverage') && !xmlContent.includes('<coverage>')) {
                this.outputChannel.appendLine(`WARNING: File does not appear to be Clover XML format`);
            }

            // Parse XML
            const parsedXml: any = await parseStringAsync(xmlContent, {
                explicitArray: false,
                mergeAttrs: true
            });

            // Extract coverage data from Clover XML structure
            const coverageMap = new Map<string, FileCoverageData>();

            // Clover XML structure usually: coverage > project > package > file > line
            // Some generators omit <package> and put <file> directly under <project>
            const coverage = parsedXml.coverage;
            if (!coverage) {
                this.outputChannel.appendLine(`WARNING: No coverage element found in XML`);
                return coverageMap;
            }

            const project = coverage.project;
            if (!project) {
                this.outputChannel.appendLine(`WARNING: No project element found in coverage XML`);
                return coverageMap;
            }

            const toArray = <T>(value: T | T[] | undefined): T[] => {
                if (!value) {
                    return [];
                }
                return Array.isArray(value) ? value.filter(Boolean) as T[] : [value];
            };

            const fileContainers: Array<{ name?: string; file?: any }> = [];

            const packages = toArray(project.package);
            if (packages.length > 0) {
                fileContainers.push(...packages);
            } else {
                if (project.file) {
                    fileContainers.push({ name: 'project', file: project.file });
                }

                const directories = toArray(project.directory);
                if (directories.length > 0) {
                    fileContainers.push(...directories);
                }

                if (fileContainers.length === 0) {
                    this.outputChannel.appendLine(`WARNING: No file nodes found in coverage XML`);
                    return coverageMap;
                }
            }
            
            for (const container of fileContainers) {
                // Extract files from the container
                // For packages: container.file
                // For project-level: the file property we set
                const files = toArray(container.file);

                for (const file of files) {
                    if (!file || !file.path) continue;

                    const filePath = file.path;
                    const lines: LineCoverage[] = [];

                    const fileLines = toArray(file.line);

                    for (const line of fileLines) {
                        if (!line) continue;

                        const lineNumber = parseInt(line.num, 10);
                        const count = parseInt(line.count || '0', 10);
                        const type = line.type;

                        if (type === 'stmt' && !isNaN(lineNumber)) {
                            lines.push({
                                lineNumber,
                                executionCount: count
                            });
                        }
                    }

                    if (lines.length > 0) {
                        coverageMap.set(filePath, {
                            filePath,
                            lines
                        });
                    }
                }
            }

            return coverageMap;

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR parsing coverage XML: ${errorMessage}`);
            
            // Don't throw - return empty map so tests can still complete
            return new Map();
        } finally {
            // Cleanup file handles and streams
            try {
                if (fileHandle) {
                    await fileHandle.close();
                }
                if (fileStream) {
                    fileStream.close();
                }
            } catch (cleanupError: any) {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * Convert coverage data to VSCode FileCoverage objects
     * @param coverageData Map of file paths to coverage data
     * @param workspaceRoot Workspace root path for resolving relative paths
     * @param dockerWorkdir Optional Docker working directory for path conversion
     * @returns Array of VSCode FileCoverage objects
     */
    public convertToVSCodeCoverage(
        coverageData: Map<string, FileCoverageData>,
        workspaceRoot: string,
        dockerWorkdir?: string
    ): vscode.FileCoverage[] {
        const fileCoverages: vscode.FileCoverage[] = [];

        try {
            for (const [filePath, data] of coverageData.entries()) {
                // DEV: Uncomment for debugging
                // this.outputChannel.appendLine(`[CoverageParser] Processing coverage path: ${filePath}`);
                
                // Resolve absolute file path
                let absolutePath: string;
                
                // Handle Docker container paths
                if (dockerWorkdir && path.posix.isAbsolute(filePath)) {
                    // This is a container absolute path (POSIX format)
                    // Convert to host path
                    const relativePath = path.posix.relative(dockerWorkdir, filePath);
                    absolutePath = path.join(workspaceRoot, relativePath.split(path.posix.sep).join(path.sep));
                } else if (path.isAbsolute(filePath)) {
                    // Host absolute path
                    absolutePath = filePath;
                } else {
                    // Relative path - resolve from workspace root
                    absolutePath = path.resolve(workspaceRoot, filePath);
                }

                // Normalize path separators
                absolutePath = path.normalize(absolutePath);

                // Check if file exists
                if (!fs.existsSync(absolutePath)) {
                    // Try alternative resolution: check if it's a src file path
                    // Codeception coverage may reference src files relative to project root
                    const altPath = path.join(workspaceRoot, filePath);
                    if (fs.existsSync(altPath)) {
                        absolutePath = altPath;
                    } else {
                        // Try without leading slash if present
                        const cleanPath = filePath.replace(/^\/+/, '');
                        const altPath2 = path.join(workspaceRoot, cleanPath);
                        if (fs.existsSync(altPath2)) {
                            absolutePath = altPath2;
                        } else {
                            this.outputChannel.appendLine(`WARNING: Coverage file not found: ${absolutePath}`);
                            continue;
                        }
                    }
                }

                // Create StatementCoverage objects for each line
                const statements = data.lines.map(line => {
                    // VSCode uses 0-based line numbers
                    const lineRange = new vscode.Range(
                        line.lineNumber - 1,
                        0,
                        line.lineNumber - 1,
                        999 // End of line
                    );

                    return new vscode.StatementCoverage(
                        line.executionCount,
                        lineRange
                    );
                });

                // Create FileCoverage from details
                const fileCoverage = vscode.FileCoverage.fromDetails(
                    vscode.Uri.file(absolutePath),
                    statements
                );

                fileCoverages.push(fileCoverage);
            }
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR converting to VSCode coverage: ${errorMessage}`);
        }

        return fileCoverages;
    }

    /**
     * Calculate coverage summary statistics
     * @param coverageData Map of file paths to coverage data
     * @returns Coverage summary with totals and percentage
     */
    public calculateSummary(coverageData: Map<string, FileCoverageData>): CoverageParseResult['summary'] {
        let totalLines = 0;
        let coveredLines = 0;

        for (const data of coverageData.values()) {
            for (const line of data.lines) {
                totalLines++;
                if (line.executionCount > 0) {
                    coveredLines++;
                }
            }
        }

        const percentage = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0;

        return {
            totalLines,
            coveredLines,
            percentage: Math.round(percentage * 100) / 100 // Round to 2 decimal places
        };
    }
}

