import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

export interface StreamingOptions {
    onOutput: (data: string) => void;
    onTestResult: (testName: string, passed: boolean, output?: string) => void;
    onComplete: (exitCode: number) => void;
    onError: (error: Error) => void;
    cwd: string;
    timeout?: number;
}

/**
 * Executes commands with streaming output support
 * Uses spawn() instead of exec() to enable real-time output processing
 */
export class StreamingTestExecutor {
    private lineBuffer: string = '';
    private stderrBuffer: string = '';
    private process: ChildProcess | null = null;
    private timeoutHandle: NodeJS.Timeout | null = null;

    /**
     * Execute a command with streaming output
     */
    public async executeWithStreaming(command: string, options: StreamingOptions): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // When using shell: true, pass the entire command as a single string
                // This ensures complex commands (like Docker with environment variables) work correctly
                
                // Logging will be handled by the caller via onOutput callback

                // Spawn the process with shell
                // Use sh -c on Unix or cmd /c on Windows to execute the full command string
                this.process = spawn(command, {
                    cwd: options.cwd,
                    shell: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                // Set timeout if specified
                if (options.timeout) {
                    this.timeoutHandle = setTimeout(() => {
                        if (this.process && !this.process.killed) {
                            options.onOutput(`\r\n[Streaming] Timeout after ${options.timeout}ms, killing process\r\n`);
                            this.process.kill('SIGTERM');
                            reject(new Error(`Command timed out after ${options.timeout}ms`));
                        }
                    }, options.timeout);
                }

                // Handle stdout (test output)
                this.process.stdout?.on('data', (chunk: Buffer) => {
                    const data = chunk.toString();
                    options.onOutput(data);
                    this.processChunk(data, options);
                });

                // Handle stderr (errors)
                this.process.stderr?.on('data', (chunk: Buffer) => {
                    const data = chunk.toString();
                    this.stderrBuffer += data;
                    options.onOutput(data);
                    this.processChunk(data, options);
                });

                // Handle process completion
                this.process.on('close', (code: number | null, signal: string | null) => {
                    this.cleanup();
                    
                    if (signal === 'SIGTERM') {
                        reject(new Error('Process was terminated'));
                        return;
                    }

                    const exitCode = code ?? 0;
                    options.onComplete(exitCode);
                    resolve();
                });

                // Handle process errors
                this.process.on('error', (error: Error) => {
                    this.cleanup();
                    options.onError(error);
                    reject(error);
                });

            } catch (error: any) {
                this.cleanup();
                options.onError(error);
                reject(error);
            }
        });
    }

    /**
     * Cancel the running process
     */
    public cancel(): void {
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
        }
        this.cleanup();
    }

    /**
     * Parse command string into executable and args for spawn
     */
    private parseCommand(command: string): { executable: string; args: string[] } {
        // For shell commands, we'll use shell: true, so just split by spaces
        // But handle quoted arguments properly
        const parts: string[] = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < command.length; i++) {
            const char = command[i];

            if ((char === '"' || char === "'") && !inQuotes) {
                inQuotes = true;
                quoteChar = char;
            } else if (char === quoteChar && inQuotes) {
                inQuotes = false;
                quoteChar = '';
            } else if (char === ' ' && !inQuotes) {
                if (current.trim()) {
                    parts.push(current.trim());
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current.trim()) {
            parts.push(current.trim());
        }

        if (parts.length === 0) {
            throw new Error('Empty command');
        }

        return {
            executable: parts[0],
            args: parts.slice(1),
        };
    }

    /**
     * Process output chunks and extract complete lines
     */
    private processChunk(chunk: string, options: StreamingOptions): void {
        this.lineBuffer += chunk;
        const lines = this.lineBuffer.split('\n');
        
        // Keep the last incomplete line in buffer
        this.lineBuffer = lines.pop() || '';

        // Process each complete line
        for (const line of lines) {
            this.parseLine(line.trim(), options);
        }
    }

    /**
     * Parse a single line of output for test results
     */
    private parseLine(line: string, options: StreamingOptions): void {
        if (!line) {
            return;
        }

        // Pattern 1: ✓ testMethodName or ✗ testMethodName (pretty format)
        // Also handles: ✓ testMethodName (ClassName) or ✗ testMethodName (ClassName)
        const checkmarkMatch = line.match(/[✓✗]\s+(\w+)(?:\s+\([^)]+\))?/);
        if (checkmarkMatch) {
            const testName = checkmarkMatch[1];
            const passed = line.includes('✓');
            options.onTestResult(testName, passed, line);
            return;
        }

        // Pattern 2: testMethodName: OK|FAILED|PASSED|ERROR
        const colonMatch = line.match(/^(\w+):\s*(OK|FAILED|PASSED|ERROR)/i);
        if (colonMatch) {
            const testName = colonMatch[1];
            const status = colonMatch[2].toUpperCase();
            const passed = status === 'OK' || status === 'PASSED';
            options.onTestResult(testName, passed, line);
            return;
        }

        // Pattern 3: testMethodName (ClassName) ... OK
        const verboseMatch = line.match(/^(\w+)\s+\([^)]+\)\s+\.\.\.\s+(OK|FAILED|PASSED|ERROR)/i);
        if (verboseMatch) {
            const testName = verboseMatch[1];
            const status = verboseMatch[2].toUpperCase();
            const passed = status === 'OK' || status === 'PASSED';
            options.onTestResult(testName, passed, line);
            return;
        }

        // Pattern 4: TAP format - ok 1 - testName
        const tapOkMatch = line.match(/^ok\s+\d+\s+-\s+(\w+)/i);
        if (tapOkMatch) {
            const testName = tapOkMatch[1];
            options.onTestResult(testName, true, line);
            return;
        }

        // Pattern 5: TAP format - not ok 1 - testName
        const tapFailMatch = line.match(/^not\s+ok\s+\d+\s+-\s+(\w+)/i);
        if (tapFailMatch) {
            const testName = tapFailMatch[1];
            options.onTestResult(testName, false, line);
            return;
        }

        // Pattern 6: Codeception detailed format - Test  path:methodName
        const detailedMatch = line.match(/Test\s+[^\s]+:([A-Za-z0-9_]+)/);
        if (detailedMatch) {
            const testName = detailedMatch[1];
            // This usually indicates a failure
            options.onTestResult(testName, false, line);
            return;
        }
    }

    /**
     * Cleanup resources
     */
    private cleanup(): void {
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = null;
        }
        this.lineBuffer = '';
        this.stderrBuffer = '';
    }
}

