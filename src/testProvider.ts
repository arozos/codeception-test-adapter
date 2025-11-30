import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as glob from 'glob';
import { PhpTestParser } from './phpParser';
import { ParsedTestFile } from './types';
import { StreamingTestExecutor } from './streamingExecutor';
import { CoverageParser } from './coverageParser';
import { CoverageManager } from './coverageManager';
import { JunitParser } from './junitParser';
import { DockerService } from './dockerService';

const execAsync = promisify(exec);

export class CodeceptionTestProvider {
    private testController: vscode.TestController;
    private workspaceRoot: string;
    private fileWatcher?: vscode.FileSystemWatcher;
    private phpParser: PhpTestParser;
    private outputChannel: vscode.OutputChannel;
    private streamingExecutor: StreamingTestExecutor;
    private coverageParser: CoverageParser;
    private coverageManager: CoverageManager;
    private junitParser: JunitParser;
    private dockerService: DockerService;

    constructor(controller: vscode.TestController, outputChannel: vscode.OutputChannel, coverageManager: CoverageManager) {
        this.outputChannel = outputChannel;
        
        this.testController = controller;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        
        try {
            this.phpParser = new PhpTestParser(outputChannel);
        } catch (error: any) {
            this.outputChannel.appendLine(`ERROR: Failed to initialize PHP parser: ${error.message}`);
            throw error;
        }

        // Initialize streaming executor
        this.streamingExecutor = new StreamingTestExecutor();

        // Initialize Docker service
        this.dockerService = new DockerService(outputChannel);

        // Initialize coverage components
        this.coverageManager = coverageManager;
        this.coverageParser = new CoverageParser(outputChannel, this.dockerService);

        // Initialize JUnit XML parser for accurate test results
        this.junitParser = new JunitParser(outputChannel, this.dockerService);

        // Set up refresh handler - called when user clicks the refresh button in Test Explorer
        controller.refreshHandler = async (token) => {
            this.outputChannel.appendLine('[TestProvider] Refresh button clicked - rediscovering tests');
            await this.discoverTests();
        };

        // Set up run profile
        const runProfile = controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => {
                return this.runTests(request, token);
            },
            true
        );
        runProfile.isDefault = true;

        // Set up coverage run profile
        const coverageProfile = controller.createRunProfile(
            'Run with Coverage',
            vscode.TestRunProfileKind.Coverage,
            (request, token) => {
                return this.runTestsWithCoverage(request, token);
            },
            false
        );
        coverageProfile.isDefault = false;

        // Set up debug profile
        const debugProfile = controller.createRunProfile(
            'Debug',
            vscode.TestRunProfileKind.Debug,
            (request, token) => {
                return this.debugTests(request, token);
            },
            false
        );
        debugProfile.isDefault = false;

        // Watch for test file changes
        this.setupFileWatcher();
    }

    private setupFileWatcher() {
        // Create file system watcher for test files
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*{Test,Cest,Cept}.php');
        
        // When files change, rediscover tests
        // Test results are preserved by VSCode (standard behavior)
        this.fileWatcher.onDidCreate(() => this.discoverTests());
        this.fileWatcher.onDidChange(() => this.discoverTests());
        this.fileWatcher.onDidDelete(() => this.discoverTests());
    }

    /**
     * Dispose of resources to prevent memory leaks
     */
    public dispose() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }

    /**
     * Get Docker configuration if enabled
     * @returns Docker configuration object or null if Docker is not enabled
     */
    private getDockerConfig(): { container: string; workdir: string } | null {
        const config = vscode.workspace.getConfiguration('codeceptionphp');
        const useDocker = config.get<boolean>('docker.enabled', false);
        
        if (!useDocker) {
            return null;
        }

        const container = config.get<string>('docker.container', '');
        const workdir = config.get<string>('docker.workdir', '');

        if (!container) {
            return null;
        }

        return { container, workdir };
    }

    /**
     * Discovers tests from the workspace.
     * Test results are preserved across discovery - this matches the behavior
     * of popular test extensions (Jest, Python Test Explorer, etc.)
     * Users can re-run tests to update their states.
     */
    public async discoverTests() {
        // Replace all test items with fresh ones
        // Note: VSCode preserves test results by TestController ID + TestItem ID
        // So when we recreate items with the same IDs, previous results are retained
        this.testController.items.replace([]);

        const config = vscode.workspace.getConfiguration('codeceptionphp');
        const suites = config.get<string[]>('suites', ['unit', 'functional', 'acceptance']);

        for (const suite of suites) {
            await this.discoverSuiteTests(suite);
        }
    }

    private async discoverSuiteTests(suite: string) {
        const testsDir = path.join(this.workspaceRoot, 'tests', suite);
        
        if (!fs.existsSync(testsDir)) {
            return;
        }

        // Find all test files
        const pattern = path.join(testsDir, '**/*{Test,Cest,Cept}.php');
        const files = glob.sync(pattern);

        // Create suite item if it doesn't exist
        let suiteItem = this.testController.items.get(suite);
        if (!suiteItem) {
            suiteItem = this.testController.createTestItem(
                suite,
                suite.charAt(0).toUpperCase() + suite.slice(1),
                vscode.Uri.file(testsDir)
            );
            // Suite items can have children (test files)
            suiteItem.canResolveChildren = true;
            this.testController.items.add(suiteItem);
        }

        for (const file of files) {
            await this.parseTestFile(file, suite, suiteItem);
        }
    }

    private async parseTestFile(filePath: string, suite: string, suiteItem: vscode.TestItem) {
        const uri = vscode.Uri.file(filePath);
        const relativePath = path.relative(this.workspaceRoot, filePath);

        // Create file test item
        const fileId = `${suite}:${relativePath}`;
        let fileItem = suiteItem.children.get(fileId);
        
        if (!fileItem) {
            fileItem = this.testController.createTestItem(
                fileId,
                path.basename(filePath),
                uri
            );
            // File items can have children (test methods)
            fileItem.canResolveChildren = true;
            suiteItem.children.add(fileItem);
        }

        // Try AST parsing first
        const parsed = this.phpParser.parseTestFile(filePath);

        // If AST parsing found no methods, fall back to regex parsing
        // This handles cases where:
        // - AST parsing failed silently
        // - File has no test methods
        // - File uses syntax not supported by parser
        if (parsed.methods.length === 0) {
            this.parseTestFileRegex(filePath, fileId, fileItem, uri);
            return;
        }

        // Process AST-parsed methods
        for (const method of parsed.methods) {
            const testId = `${fileId}::${method.name}`;
            
            // Create test item with accurate line numbers
            const testItem = this.testController.createTestItem(
                testId,
                method.name,
                uri
            );

            // Set accurate range from AST
            testItem.range = new vscode.Range(
                method.line - 1,
                0,
                method.endLine - 1,
                0
            );

            // Ensure test item can be run (required for coverage support)
            testItem.canResolveChildren = false; // Leaf nodes don't have children

            // Add test groups as tags
            if (method.annotations.groups && method.annotations.groups.length > 0) {
                testItem.tags = method.annotations.groups.map(group => 
                    new vscode.TestTag(group)
                );
            }

            // Handle data providers
            if (method.annotations.dataProvider) {
                // For data providers, create a parent test item
                // The actual data provider datasets would be discovered by parsing the data provider method
                // For now, we create a single test item indicating it uses a data provider
                const dataProviderTestId = `${testId}[${method.annotations.dataProvider}]`;
                const dataProviderItem = this.testController.createTestItem(
                    dataProviderTestId,
                    `${method.name} (${method.annotations.dataProvider})`,
                    uri
                );
                dataProviderItem.range = testItem.range;
                if (method.annotations.groups && method.annotations.groups.length > 0) {
                    dataProviderItem.tags = method.annotations.groups.map(group => 
                        new vscode.TestTag(group)
                    );
                }
                fileItem.children.add(dataProviderItem);
            } else {
                // Regular test method without data provider
                fileItem.children.add(testItem);
            }
        }
    }

    /**
     * Fallback regex-based parsing when AST parsing fails or finds no methods
     */
    private parseTestFileRegex(
        filePath: string,
        fileId: string,
        fileItem: vscode.TestItem,
        uri: vscode.Uri
    ): void {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        
        // Match: public function testSomething or public function something (for Cest)
        const testMethodRegex = /public\s+function\s+(test\w+|\w+)\s*\(/g;
        let match;

        while ((match = testMethodRegex.exec(fileContent)) !== null) {
            const methodName = match[1];
            
            // Skip constructor and _before/_after methods
            if (methodName === '__construct' || methodName.startsWith('_')) {
                continue;
            }

            const testId = `${fileId}::${methodName}`;
            const testItem = this.testController.createTestItem(
                testId,
                methodName,
                uri
            );

            // Try to find line number (approximate)
            const lines = fileContent.substring(0, match.index).split('\n');
            const lineNumber = lines.length - 1;
            testItem.range = new vscode.Range(lineNumber, 0, lineNumber, 0);

            // Ensure test item can be run (required for coverage support)
            testItem.canResolveChildren = false; // Leaf nodes don't have children

            fileItem.children.add(testItem);
        }
    }

    private async runTests(request: vscode.TestRun | vscode.TestRunRequest, token: vscode.CancellationToken) {
        // Check if coverage should always run
        const config = vscode.workspace.getConfiguration('codeceptionphp');
        const alwaysRunCoverage = config.get<boolean>('coverage.alwaysRun', false);

        if (alwaysRunCoverage) {
            this.outputChannel.appendLine('[TestRun] Coverage always enabled - delegating to coverage run');
            return this.runTestsWithCoverage(request as vscode.TestRunRequest, token);
        }

        const run = this.testController.createTestRun(request as vscode.TestRunRequest);
        const queue: vscode.TestItem[] = [];

        // Collect tests to run
        if ((request as vscode.TestRunRequest).include) {
            (request as vscode.TestRunRequest).include?.forEach(test => queue.push(test));
        } else {
            this.testController.items.forEach(test => queue.push(test));
        }

        // Set up cancellation handler
        const cancellationToken = token.onCancellationRequested(() => {
            this.streamingExecutor.cancel();
        });

        try {
            for (const test of queue) {
                if (token.isCancellationRequested) {
                    run.skipped(test);
                    continue;
                }

                await this.runTest(test, run, token);
            }
        } finally {
            cancellationToken.dispose();
            run.end();
        }
    }

    /**
     * Run tests with coverage enabled
     * Generates coverage files, parses them, and attaches to test run
     */
    private async runTestsWithCoverage(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = this.testController.createTestRun(request);
        const queue: vscode.TestItem[] = [];
        let coverageFilePath: string | null = null;

        // Collect tests to run
        if (request.include) {
            request.include.forEach(test => {
                queue.push(test);
            });
        } else {
            this.testController.items.forEach(test => {
                queue.push(test);
            });
        }

        // Set up cancellation handler
        const cancellationToken = token.onCancellationRequested(() => {
            this.streamingExecutor.cancel();
        });

        // Check if Docker is enabled (declare once for entire method)
        const config = vscode.workspace.getConfiguration('codeceptionphp');
        const useDocker = config.get<boolean>('docker.enabled', false);
        const dockerWorkdir = useDocker ? config.get<string>('docker.workdir', '') : undefined;

        try {
            // Determine suite name for coverage file naming (if running a single suite)
            let suiteName: string | undefined;
            if (queue.length === 1 && queue[0].children.size > 0) {
                suiteName = queue[0].id;
            }

            // Generate unique coverage file path (container path if Docker, host path otherwise)
            coverageFilePath = this.coverageManager.generateCoverageFilePath(
                this.workspaceRoot, 
                suiteName,
                dockerWorkdir
            );

            // Run tests with coverage
            // IMPORTANT: Run all tests in a SINGLE command to get cumulative coverage
            // Running tests one-by-one causes each test to overwrite the coverage.xml file
            
            if (queue.length === 1) {
                // Single test - run directly
                const test = queue[0];
                await this.runTestWithCoverage(test, run, coverageFilePath, token);
            } else {
                // Multiple tests - run as a batch to get cumulative coverage
                
                // Build a single command that runs all tests
                const config = vscode.workspace.getConfiguration('codeceptionphp');
                const binary = config.get<string>('binary.path', 'vendor/bin/codecept');
                
                // Group tests by suite to build efficient commands
                const testsBySuite = new Map<string, vscode.TestItem[]>();
                for (const test of queue) {
                    const suiteId = test.id.split(':')[0];
                    if (!testsBySuite.has(suiteId)) {
                        testsBySuite.set(suiteId, []);
                    }
                    testsBySuite.get(suiteId)!.push(test);
                }
                
                // Run each suite with coverage
                for (const [suiteId, tests] of testsBySuite) {
                    if (token.isCancellationRequested) {
                        tests.forEach(t => run.skipped(t));
                        continue;
                    }
                    
                    // For suite-level runs, just run the whole suite
                    const command = this.buildTestCommand(binary, suiteId, coverageFilePath);
                    
                    // Mark all tests as started
                    tests.forEach(t => run.started(t));
                    
                    // Execute the suite
                    await this.executeTestWithStreaming(tests[0], run, command, token);
                }
            }

            // Parse and attach coverage
            // Codeception outputs coverage to tests/_output/coverage.xml by default
            const defaultCoveragePath = path.join(this.workspaceRoot, 'tests', '_output', 'coverage.xml');
            
            // Wait a moment for file to be written (increase wait time for Docker)
            const waitTime = useDocker ? 1000 : 500;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Also check for coverage files in Docker if applicable
            let coveragePath = defaultCoveragePath;
            if (useDocker && dockerWorkdir) {
                // In Docker, coverage might be generated in container path
                // Try to find coverage.xml in the output directory
                const outputDir = path.join(this.workspaceRoot, 'tests', '_output');
                if (fs.existsSync(outputDir)) {
                    const files = fs.readdirSync(outputDir);
                    const coverageFiles = files.filter(f => f.includes('coverage') && f.endsWith('.xml'));
                    if (coverageFiles.length > 0) {
                        coveragePath = path.join(outputDir, coverageFiles[0]);
                    }
                }
            }
            
            if (fs.existsSync(coveragePath)) {
                // Validate file size
                const stats = fs.statSync(coveragePath);
                
                if (stats.size === 0) {
                    this.outputChannel.appendLine('WARNING: Coverage file is empty');
                } else {
                    // Get Docker config for reading coverage file
                    const dockerConfig = this.getDockerConfig();
                    const containerCoveragePath = dockerConfig && dockerWorkdir 
                        ? `${dockerWorkdir}/tests/_output/coverage.xml`
                        : undefined;

                    const coverageData = await this.coverageParser.parseCloverXml(
                        coveragePath,
                        containerCoveragePath,
                        dockerConfig?.container
                    );
                    
                    if (coverageData.size === 0) {
                        this.outputChannel.appendLine('WARNING: No coverage data found in XML file');
                        this.outputChannel.appendLine('This may indicate:');
                        this.outputChannel.appendLine('  1. No source files were executed');
                        this.outputChannel.appendLine('  2. Coverage paths are not configured in codeception.yml');
                        this.outputChannel.appendLine('  3. Xdebug coverage mode is not enabled');
                    } else {
                        const fileCoverages = this.coverageParser.convertToVSCodeCoverage(
                            coverageData, 
                            this.workspaceRoot,
                            dockerWorkdir
                        );

                        // Attach coverage to test run
                        let attachedCount = 0;
                        for (const fileCoverage of fileCoverages) {
                            try {
                                run.addCoverage(fileCoverage);
                                attachedCount++;
                            } catch (error: any) {
                                this.outputChannel.appendLine(`ERROR attaching coverage for ${fileCoverage.uri.fsPath}: ${error.message}`);
                            }
                        }

                        // Log summary
                        const summary = this.coverageParser.calculateSummary(coverageData);
                        this.outputChannel.appendLine(
                            `Coverage: ${summary.coveredLines}/${summary.totalLines} lines (${summary.percentage}%)`
                        );

                        // Show success notification
                        if (attachedCount > 0) {
                            vscode.window.showInformationMessage(
                                `Coverage collected: ${summary.percentage}% (${summary.coveredLines}/${summary.totalLines} lines)`,
                                'View Coverage'
                            ).then(selection => {
                                if (selection === 'View Coverage') {
                                    // Focus on test coverage view
                                    vscode.commands.executeCommand('testing.showCoverage');
                                }
                            });
                        }
                    }
                }
            } else {
                this.outputChannel.appendLine('WARNING: Coverage file not generated');
                this.outputChannel.appendLine('Coverage requires:');
                this.outputChannel.appendLine('  1. Xdebug installed and enabled (xdebug.mode=coverage)');
                this.outputChannel.appendLine('  2. Coverage enabled in codeception.yml');
                this.outputChannel.appendLine('  3. Include paths configured in codeception.yml');
            }

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`ERROR: ${errorMessage}`);
            
            // Show user-friendly error
            vscode.window.showWarningMessage(
                `Coverage collection failed: ${errorMessage}. Test results are still available.`,
                'View Output'
            ).then(selection => {
                if (selection === 'View Output') {
                    this.outputChannel.show();
                }
            });
        } finally {
            // NOTE: We do NOT cleanup coverage.xml - it's a generated artifact that should persist
            // Codeception will overwrite it on the next coverage run automatically
            // This allows users to inspect the coverage file and enables proper coverage display
            cancellationToken.dispose();
            run.end();
        }
    }

    /**
     * Execute test with streaming output for real-time result updates
     */
    private async executeTestWithStreaming(
        test: vscode.TestItem,
        run: vscode.TestRun,
        command: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Track which tests have been seen in output
        const seenTests = new Set<string>();
        const testResults = new Map<string, { passed: boolean; output: string }>();
        let allOutput = '';
        let hasFatalError = false;

        // Build a map of test names to test items for quick lookup
        const testNameMap = this.buildTestNameMap(test);

        try {
            await this.streamingExecutor.executeWithStreaming(command, {
                cwd: this.workspaceRoot,
                timeout: 300000, // 5 minute timeout
                onOutput: (data: string) => {
                    // Append to output pane
                    allOutput += data;
                    const cleanedOutput = this.cleanCodeceptionOutput(data);
                    if (cleanedOutput) {
                        run.appendOutput(cleanedOutput);
                    }
                },
                onTestResult: (testName: string, passed: boolean, output?: string) => {
                    // Find and mark the test item
                    const testItem = testNameMap.get(testName);
                    if (testItem) {
                        // Only mark if we haven't seen this test yet
                        if (!seenTests.has(testName)) {
                            run.started(testItem);
                            seenTests.add(testName);
                            testResults.set(testName, { passed, output: output || '' });

                            if (passed) {
                                run.passed(testItem);
                            } else {
                                const message = output 
                                    ? new vscode.TestMessage(output)
                                    : this.createErrorMessage(allOutput, '', testItem);
                                run.failed(testItem, message);
                            }
                        }
                    } else {
                        // Test not found in map - might be a different format
                        // DEV: Uncomment for debugging
                        // this.outputChannel.appendLine(`[Streaming] Test result for unknown test: ${testName}`);
                    }
                },
                onComplete: async (exitCode: number) => {
                    // Mark any tests that weren't seen as passed (Codeception only reports failures)
                    this.markUnseenTests(test, run, seenTests, testNameMap);

                    // Reconcile with XML results for accuracy (XML is source of truth)
                    await this.reconcileWithXmlResults(test, run, seenTests, testNameMap, testResults);

                    // Check for fatal errors
                    hasFatalError = this.detectFatalError(allOutput, '');

                    // Mark parent test based on results
                    const hasFailures = exitCode !== 0 || hasFatalError || 
                                       Array.from(testResults.values()).some(r => !r.passed);

                    if (hasFailures) {
                        const message = this.createErrorMessage(allOutput, '', test);
                        run.failed(test, message);
                    } else {
                        run.passed(test);
                    }
                },
                onError: (error: Error) => {
                    const message = new vscode.TestMessage(`Test execution failed: ${error.message}`);
                    run.failed(test, message);
                },
            });
        } catch (error: any) {
            const errorMessage = error?.message || String(error);

            // Check for Docker-specific errors
            const isDockerError = this.isDockerError(errorMessage, allOutput);
            
            if (isDockerError) {
                const dockerErrorMsg = this.getDockerErrorMessage(errorMessage, allOutput);
                this.outputChannel.appendLine(`Docker ERROR: ${dockerErrorMsg}`);
                run.appendOutput(`\r\nDocker Error: ${dockerErrorMsg}\r\n`);
                
                vscode.window.showErrorMessage(
                    `Docker Error: ${dockerErrorMsg}`,
                    'View Output',
                    'Disable Docker'
                ).then(async selection => {
                    if (selection === 'View Output') {
                        this.outputChannel.show();
                    } else if (selection === 'Disable Docker') {
                        const config = vscode.workspace.getConfiguration('codeceptionphp');
                        await config.update('docker.enabled', false, vscode.ConfigurationTarget.Workspace);
                        vscode.window.showInformationMessage('Docker support disabled. Tests will run locally.');
                    }
                });
                
                const message = new vscode.TestMessage(`Docker execution failed: ${dockerErrorMsg}`);
                run.failed(test, message);
                return;
            }

            // Handle cancellation
            if (token.isCancellationRequested) {
                run.appendOutput('\r\nTest run cancelled by user\r\n');
                // Mark remaining tests as skipped
                this.markUnseenTests(test, run, seenTests, testNameMap);
                return;
            }

            // Other errors
            const message = new vscode.TestMessage(`Test execution failed: ${errorMessage}`);
            run.failed(test, message);
        }
    }

    /**
     * Build a map of test method names to test items for quick lookup
     * Supports multiple name formats for matching
     */
    private buildTestNameMap(parentTest: vscode.TestItem): Map<string, vscode.TestItem> {
        const map = new Map<string, vscode.TestItem>();

        const addTest = (test: vscode.TestItem) => {
            // Extract method name from test ID (format: "suite:file::methodName")
            const testId = test.id;
            if (testId.includes('::')) {
                const methodName = testId.split('::').pop() || '';
                if (methodName) {
                    // Add multiple variations for matching
                    map.set(methodName, test);
                    map.set(methodName.toLowerCase(), test);
                    
                    // Handle test prefix removal (testMethodName -> methodName)
                    if (methodName.toLowerCase().startsWith('test')) {
                        const withoutTest = methodName.substring(4);
                        map.set(withoutTest, test);
                        map.set(withoutTest.toLowerCase(), test);
                    }
                }
            }

            // Recursively add children
            test.children.forEach(child => addTest(child));
        };

        parentTest.children.forEach(child => addTest(child));
        return map;
    }

    /**
     * Mark tests that weren't seen in output as passed
     * Note: Codeception only prints detailed info for failing tests
     * Tests not explicitly mentioned in output are assumed to have passed
     * This matches the behavior of parseAndMarkChildren()
     */
    private markUnseenTests(
        parentTest: vscode.TestItem,
        run: vscode.TestRun,
        seenTests: Set<string>,
        testNameMap: Map<string, vscode.TestItem>
    ): void {
        testNameMap.forEach((testItem, testName) => {
            if (!seenTests.has(testName)) {
                // Test wasn't mentioned in output - assume it passed
                // Codeception only prints detailed info for failures
                run.started(testItem);
                run.passed(testItem);
            }
        });
    }

    /**
     * Parse XML results for a single test method (buffered execution)
     * Returns true if XML parsing succeeded, false to fall back to regex
     */
    private async parseXmlForSingleTest(
        test: vscode.TestItem,
        run: vscode.TestRun,
        stdout: string,
        stderr: string
    ): Promise<boolean> {
        try {
            const xmlPath = JunitParser.getDefaultXmlPath(this.workspaceRoot);

            // Wait for file to be written
            await new Promise(resolve => setTimeout(resolve, 300));

            if (!fs.existsSync(xmlPath)) {
                this.outputChannel.appendLine('[XML Parse] XML file not found, falling back to regex');
                return false;
            }

            // Get Docker config for reading XML file
            const dockerConfig = this.getDockerConfig();
            const containerXmlPath = dockerConfig?.workdir 
                ? `${dockerConfig.workdir}/tests/_output/report.xml`
                : undefined;

            const xmlResults = await this.junitParser.parseJUnitXml(
                xmlPath,
                containerXmlPath,
                dockerConfig?.container
            );

            if (xmlResults.size === 0) {
                this.outputChannel.appendLine('[XML Parse] No results in XML, falling back to regex');
                return false;
            }

            // Extract test method name from test ID
            const methodName = this.extractMethodName(test.id);
            const xmlResult = xmlResults.get(methodName);

            if (!xmlResult) {
                this.outputChannel.appendLine(`[XML Parse] Test ${methodName} not found in XML, falling back to regex`);
                return false;
            }

            // Mark test based on XML result
            if (xmlResult.status === 'passed') {
                run.passed(test);
                this.outputChannel.appendLine(`[XML Parse] Test ${methodName} passed (from XML)`);
            } else {
                let errorMessage = '';
                if (xmlResult.failure) {
                    errorMessage = xmlResult.failure.content || xmlResult.failure.message;
                } else if (xmlResult.error) {
                    errorMessage = xmlResult.error.content || xmlResult.error.message;
                }

                const message = new vscode.TestMessage(errorMessage || 'Test failed');
                run.failed(test, message);
                this.outputChannel.appendLine(`[XML Parse] Test ${methodName} failed (from XML)`);
            }

            return true;

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`[XML Parse] ERROR: ${errorMessage}, falling back to regex`);
            return false;
        }
    }

    /**
     * Reconcile streaming test results with JUnit XML output
     * XML is the source of truth - corrects any mismatches from regex parsing
     * This ensures 100% accuracy while maintaining real-time UX
     */
    private async reconcileWithXmlResults(
        test: vscode.TestItem,
        run: vscode.TestRun,
        seenTests: Set<string>,
        testNameMap: Map<string, vscode.TestItem>,
        testResults: Map<string, { passed: boolean; output: string }>
    ): Promise<void> {
        try {
            // Get the default XML output path
            const xmlPath = JunitParser.getDefaultXmlPath(this.workspaceRoot);

            // Wait a moment for file to be written
            await new Promise(resolve => setTimeout(resolve, 300));

            // Check if XML file exists
            if (!fs.existsSync(xmlPath)) {
                this.outputChannel.appendLine('[Reconciliation] XML file not found, using streaming results');
                return;
            }

            // Get Docker config for reading XML file
            const dockerConfig = this.getDockerConfig();
            const containerXmlPath = dockerConfig?.workdir 
                ? `${dockerConfig.workdir}/tests/_output/report.xml`
                : undefined;

            // Parse XML results
            const xmlResults = await this.junitParser.parseJUnitXml(
                xmlPath,
                containerXmlPath,
                dockerConfig?.container
            );

            if (xmlResults.size === 0) {
                this.outputChannel.appendLine('[Reconciliation] No results in XML, using streaming results');
                return;
            }

            this.outputChannel.appendLine(`[Reconciliation] Reconciling ${xmlResults.size / 2} XML results with streaming results`);

            let correctionCount = 0;

            // Compare XML results with streaming results and correct mismatches
            for (const [testName, xmlResult] of xmlResults.entries()) {
                // Skip duplicate entries (we store multiple variations for matching)
                if (testName.toLowerCase() !== testName && xmlResults.has(testName.toLowerCase())) {
                    continue;
                }

                const testItem = testNameMap.get(testName);
                if (!testItem) {
                    continue;
                }

                const streamingResult = testResults.get(testName);
                const xmlPassed = xmlResult.status === 'passed';
                const streamingPassed = streamingResult?.passed ?? true;

                // Check for mismatch
                if (xmlPassed !== streamingPassed) {
                    correctionCount++;
                    this.outputChannel.appendLine(
                        `[Reconciliation] Correcting ${testName}: streaming=${streamingPassed}, xml=${xmlPassed}`
                    );

                    // Update test status to match XML (source of truth)
                    if (xmlPassed) {
                        run.passed(testItem);
                    } else {
                        // Create error message from XML failure/error
                        let errorMessage = '';
                        if (xmlResult.failure) {
                            errorMessage = xmlResult.failure.content || xmlResult.failure.message;
                        } else if (xmlResult.error) {
                            errorMessage = xmlResult.error.content || xmlResult.error.message;
                        }

                        const message = new vscode.TestMessage(errorMessage || 'Test failed');
                        run.failed(testItem, message);
                    }
                }

                // Mark test as seen (for tests that weren't in streaming output)
                if (!seenTests.has(testName)) {
                    run.started(testItem);
                    seenTests.add(testName);

                    if (xmlPassed) {
                        run.passed(testItem);
                    } else {
                        let errorMessage = '';
                        if (xmlResult.failure) {
                            errorMessage = xmlResult.failure.content || xmlResult.failure.message;
                        } else if (xmlResult.error) {
                            errorMessage = xmlResult.error.content || xmlResult.error.message;
                        }

                        const message = new vscode.TestMessage(errorMessage || 'Test failed');
                        run.failed(testItem, message);
                    }
                }
            }

            if (correctionCount > 0) {
                this.outputChannel.appendLine(`[Reconciliation] Corrected ${correctionCount} test result(s)`);
            } else {
                this.outputChannel.appendLine('[Reconciliation] All streaming results match XML - no corrections needed');
            }

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`[Reconciliation] ERROR: ${errorMessage}`);
            // Don't throw - streaming results are still valid
        }
    }

    private buildTestCommand(binary: string, testId: string, coverageFilePath?: string): string {
        const hasMethodSeparator = testId.includes('::');
        const hasFileSeparator = testId.includes(':');

        // Get configuration
        const config = vscode.workspace.getConfiguration('codeceptionphp');
        const binaryArgs = config.get<string>('binary.args', '--steps');

        let command: string;

        if (hasMethodSeparator) {
            // Method level: "suite:file::method"
            const [fileId, method] = testId.split('::');
            const [suite, file] = fileId.split(':', 2);
            command = `${binary} run ${suite} ${file}:${method}`;
        } else if (hasFileSeparator) {
            // File level: "suite:file"
            const [suite, file] = testId.split(':', 2);
            command = `${binary} run ${suite} ${file}`;
        } else {
            // Suite level: "suite"
            command = `${binary} run ${testId}`;
        }

        // Add user-specified arguments/flags
        if (binaryArgs) {
            command += ` ${binaryArgs}`;
        }

        // Add XML output flag for accurate test result parsing
        // Codeception outputs to tests/_output/report.xml by default
        command += ` --xml`;

        // Add coverage flags if coverage file path is provided
        if (coverageFilePath) {
            // Quote the path to handle spaces and special characters
            const quotedPath = coverageFilePath.includes(' ') ? `"${coverageFilePath}"` : coverageFilePath;
            // Use --coverage-xml without path - Codeception outputs to tests/_output/coverage.xml by default
            // Then we'll copy/read from there
            command += ` --coverage --coverage-xml`;
        }

        // Check if Docker is enabled
        const useDocker = config.get<boolean>('docker.enabled', false);

        if (useDocker) {
            const container = config.get<string>('docker.container', '');
            
        if (!container) {
            this.outputChannel.appendLine('WARNING: Docker enabled but no container specified');
            vscode.window.showWarningMessage(
                    'Docker is enabled but no container is configured. Please select a container using "Codeception Test Explorer: Run From Docker..." command.',
                    'OK'
                );
                return command; // Return original command if container not set
            }

            // Get the working directory inside the container (auto-detected or configured)
            const workdir = config.get<string>('docker.workdir', '') || this.workspaceRoot;

            // If running with coverage, set XDEBUG_MODE environment variable using Docker's -e flag
            const envFlag = coverageFilePath ? '-e XDEBUG_MODE=coverage ' : '';

            // Wrap command with docker exec
            // Use -e flag to set environment variables and -w flag to set working directory inside container
            command = `docker exec ${envFlag}-w "${workdir}" ${container} ${command}`;
        }

        return command;
    }

    private cleanCodeceptionOutput(output: string): string {
        if (!output) {
            return '';
        }

        // Split into lines (keep original with ANSI codes for colors)
        const lines = output.split('\n');
        const processedLines: string[] = [];
        const seenLines = new Set<string>();

        for (let line of lines) {
            // Create a version without ANSI codes for comparison
            const lineWithoutAnsi = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
            
            // Preserve empty lines for formatting
            if (!lineWithoutAnsi) {
                processedLines.push('');
                continue;
            }

            // Skip progress indicator lines (start with '-' and don't have checkmarks)
            if (lineWithoutAnsi.startsWith('-') && !lineWithoutAnsi.includes('✔') && !lineWithoutAnsi.includes('✗')) {
                continue;
            }

            // Remove duplicate lines (Codeception prints progress then final result)
            // Use normalized version for duplicate detection
            const normalizedLine = lineWithoutAnsi.replace(/\s+/g, ' ');
            if (seenLines.has(normalizedLine)) {
                continue;
            }
            seenLines.add(normalizedLine);

            // Add the original line (with ANSI codes) to preserve colors
            processedLines.push(line.trimEnd());
        }

        return processedLines.join('\r\n') + '\r\n';
    }

    /**
     * Run a single test with coverage support
     */
    private async runTestWithCoverage(
        test: vscode.TestItem,
        run: vscode.TestRun,
        coverageFilePath: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        run.started(test);

        try {
            const config = vscode.workspace.getConfiguration('codeceptionphp');
            const binary = config.get<string>('binary.path', 'vendor/bin/codecept');
            
            // Build command with coverage flags
            const command = this.buildTestCommand(binary, test.id, coverageFilePath);
            
            // Append command to output
            run.appendOutput(`Running with coverage: ${command}\r\n`);

            // Use streaming for tests with children (suite/file level), buffered for single methods
            if (test.children.size > 0) {
                await this.executeTestWithStreaming(test, run, command, token);
            } else {
                // Single test method - use buffered approach
                const { stdout, stderr } = await execAsync(command, {
                    cwd: this.workspaceRoot,
                    timeout: 300000 // 5 minute timeout
                });

                // Clean and capture output
                const cleanedOutput = this.cleanCodeceptionOutput(stdout);
                if (cleanedOutput) {
                    run.appendOutput(cleanedOutput);
                }
                if (stderr) {
                    run.appendOutput(`\r\nErrors:\r\n${stderr}\r\n`);
                }

                // Try XML parsing first (more accurate), fall back to regex if needed
                const xmlParsed = await this.parseXmlForSingleTest(test, run, stdout, stderr);

                if (!xmlParsed) {
                    // Fallback: Parse output and mark test results using regex
                    const hasFatalError = this.detectFatalError(stdout, stderr);
                    const hasFailures = stdout.includes('FAILURES!') || stdout.includes('FAILED') || stderr.includes('FAILED') || hasFatalError;
                    const hasPassed = stdout.includes('OK (') || stdout.includes('PASSED') || stdout.match(/✓/g);

                    if (hasFailures) {
                        const message = this.createErrorMessage(stdout, stderr, test);
                        run.failed(test, message);
                    } else if (hasPassed) {
                        run.passed(test);
                    } else {
                        run.passed(test);
                    }
                }
            }

        } catch (error: any) {
            // Handle errors same as regular runTest
            const stdout = error.stdout || '';
            const stderr = error.stderr || '';
            const errorMessage = error.message || error.toString();
            
            // Check for Docker-specific errors
            const isDockerError = this.isDockerError(errorMessage, stderr);
            
            if (isDockerError) {
                const dockerErrorMsg = this.getDockerErrorMessage(errorMessage, stderr);
                this.outputChannel.appendLine(`Docker ERROR: ${dockerErrorMsg}`);
                run.appendOutput(`\r\nDocker Error: ${dockerErrorMsg}\r\n`);
                
                vscode.window.showErrorMessage(
                    `Docker Error: ${dockerErrorMsg}`,
                    'View Output',
                    'Disable Docker'
                ).then(async selection => {
                    if (selection === 'View Output') {
                        this.outputChannel.show();
                    } else if (selection === 'Disable Docker') {
                        const config = vscode.workspace.getConfiguration('codeceptionphp');
                        await config.update('docker.enabled', false, vscode.ConfigurationTarget.Workspace);
                        vscode.window.showInformationMessage('Docker support disabled. Tests will run locally.');
                    }
                });
                
                const message = new vscode.TestMessage(`Docker execution failed: ${dockerErrorMsg}`);
                run.failed(test, message);
                return;
            }
            
            // Append all available output
            if (stdout) {
                const cleanedOutput = this.cleanCodeceptionOutput(stdout);
                run.appendOutput(cleanedOutput);
            }
            if (stderr) {
                run.appendOutput(`\r\nErrors:\r\n${stderr}\r\n`);
            }
            if (!stdout && !stderr) {
                run.appendOutput(`\r\nError: ${errorMessage}\r\n`);
            }
            
            // Parse output to determine if it's a test failure or execution error
            const hasFatalError = this.detectFatalError(stdout, stderr);
            const hasFailures = stdout.includes('FAILURES!') || stdout.includes('ERRORS!') || 
                               stderr.includes('FAILED') || stdout.includes('There was 1 error') ||
                               stdout.includes('There were') || hasFatalError;
            
            // If this test has children (suite or file level), parse output for individual results
            if (test.children.size > 0 && stdout) {
                this.parseAndMarkChildren(test, run, stdout, stderr, hasFailures);
            } else {
                // Leaf test (method level) - mark as failed with the full output
                const message = this.createErrorMessage(stdout, stderr, test, errorMessage);
                run.failed(test, message);
            }
        }
    }

    private async runTest(test: vscode.TestItem, run: vscode.TestRun, token: vscode.CancellationToken) {
        run.started(test);

        try {
            const config = vscode.workspace.getConfiguration('codeceptionphp');
            const binary = config.get<string>('binary.path', 'vendor/bin/codecept');
            
            // Build command based on test level
            // Test ID formats:
            //   Suite:  "unit"
            //   File:   "unit:tests/unit/path/TestFile.php"
            //   Method: "unit:tests/unit/path/TestFile.php::methodName"
            const command = this.buildTestCommand(binary, test.id);

            // Append command to output
            run.appendOutput(`Running: ${command}\r\n`);

            // Use streaming for tests with children (suite/file level), buffered for single methods
            if (test.children.size > 0) {
                await this.executeTestWithStreaming(test, run, command, token);
            } else {
                // Single test method - use buffered approach (faster for single tests)
                const { stdout, stderr } = await execAsync(command, {
                    cwd: this.workspaceRoot,
                    timeout: 300000 // 5 minute timeout
                });

                // Clean and capture output
                const cleanedOutput = this.cleanCodeceptionOutput(stdout);
                if (cleanedOutput) {
                    run.appendOutput(cleanedOutput);
                }
                if (stderr) {
                    run.appendOutput(`\r\nErrors:\r\n${stderr}\r\n`);
                }

                // Try XML parsing first (more accurate), fall back to regex if needed
                const xmlParsed = await this.parseXmlForSingleTest(test, run, stdout, stderr);

                if (!xmlParsed) {
                    // Fallback: Parse output and mark test results using regex
                    const hasFatalError = this.detectFatalError(stdout, stderr);
                    const hasFailures = stdout.includes('FAILURES!') || stdout.includes('FAILED') || stderr.includes('FAILED') || hasFatalError;
                    const hasPassed = stdout.includes('OK (') || stdout.includes('PASSED') || stdout.match(/✓/g);

                    // Leaf test (method level) - mark based on overall result
                    if (hasFailures) {
                        const message = this.createErrorMessage(stdout, stderr, test);
                        run.failed(test, message);
                    } else if (hasPassed) {
                        run.passed(test);
                    } else {
                        // If we can't determine, assume passed if no failures
                        run.passed(test);
                    }
                }
            }

        } catch (error: any) {
            // When execAsync fails, stdout/stderr are available on the error object
            const stdout = error.stdout || '';
            const stderr = error.stderr || '';
            const errorMessage = error.message || error.toString();
            
            // Check for Docker-specific errors
            const isDockerError = this.isDockerError(errorMessage, stderr);
            
            if (isDockerError) {
                // Docker execution error - show user-friendly message
                const dockerErrorMsg = this.getDockerErrorMessage(errorMessage, stderr);
                this.outputChannel.appendLine(`Docker ERROR: ${dockerErrorMsg}`);
                run.appendOutput(`\r\nDocker Error: ${dockerErrorMsg}\r\n`);
                
                // Show notification
                vscode.window.showErrorMessage(
                    `Docker Error: ${dockerErrorMsg}`,
                    'View Output',
                    'Disable Docker'
                ).then(async selection => {
                    if (selection === 'View Output') {
                        this.outputChannel.show();
                    } else if (selection === 'Disable Docker') {
                        const config = vscode.workspace.getConfiguration('codeceptionphp');
                        await config.update('docker.enabled', false, vscode.ConfigurationTarget.Workspace);
                        vscode.window.showInformationMessage('Docker support disabled. Tests will run locally.');
                    }
                });
                
                // Mark test as failed
                const message = new vscode.TestMessage(`Docker execution failed: ${dockerErrorMsg}`);
                run.failed(test, message);
                return;
            }
            
            // Append all available output
            if (stdout) {
                const cleanedOutput = this.cleanCodeceptionOutput(stdout);
                run.appendOutput(cleanedOutput);
            }
            if (stderr) {
                run.appendOutput(`\r\nErrors:\r\n${stderr}\r\n`);
            }
            if (!stdout && !stderr) {
                run.appendOutput(`\r\nError: ${errorMessage}\r\n`);
            }
            
            // Parse output to determine if it's a test failure or execution error
            const hasFatalError = this.detectFatalError(stdout, stderr);
            const hasFailures = stdout.includes('FAILURES!') || stdout.includes('ERRORS!') || 
                               stderr.includes('FAILED') || stdout.includes('There was 1 error') ||
                               stdout.includes('There were') || hasFatalError;
            
            // If this test has children (suite or file level), parse output for individual results
            if (test.children.size > 0 && stdout) {
                this.parseAndMarkChildren(test, run, stdout, stderr, hasFailures);
            } else {
                // Leaf test (method level) - mark as failed with the full output
                const message = this.createErrorMessage(stdout, stderr, test, errorMessage);
                run.failed(test, message);
            }
        }
    }

    private parseAndMarkChildren(
        parentTest: vscode.TestItem,
        run: vscode.TestRun,
        stdout: string,
        stderr: string,
        hasFailures: boolean
    ) {
        // Parse individual test results from output
        const testResults = this.parseTestResults(stdout, stderr);
        
        // Check for fatal errors and extract file info
        const hasFatalError = this.detectFatalError(stdout, stderr);
        const fatalErrorInfo = hasFatalError ? this.extractFatalErrorInfo(stdout, stderr) : null;
        
        // If there's a fatal error and no test results, it means execution stopped early
        // We should only mark the file with the fatal error, not assume others passed
        const executionStoppedEarly = hasFatalError && testResults.size === 0;
        
        // Track if we found any test results in the output
        let foundAnyResults = false;
        let allChildrenPassed = true;
        let someChildrenFailed = false;
        let ranChildrenCount = 0;

        // If execution stopped early due to fatal error, only process the file with the error
        if (executionStoppedEarly && fatalErrorInfo) {
            // DEV: Uncomment for debugging
            // this.outputChannel.appendLine('[Codeception] Fatal error detected - only marking affected file');
            
            // Find and mark only the file with the fatal error
            parentTest.children.forEach(child => {
                const childFilePath = child.uri?.fsPath;
                const isFatalErrorFile = childFilePath && childFilePath.includes(fatalErrorInfo.file || '');
                
                if (isFatalErrorFile && child.children.size > 0) {
                    run.started(child);
                    foundAnyResults = true;
                    someChildrenFailed = true;
                    
                    // Mark all methods in this file as failed
                    child.children.forEach(methodTest => {
                        run.started(methodTest);
                        const message = this.createErrorMessage(stdout, stderr, methodTest, 'Fatal error prevented test execution');
                        run.failed(methodTest, message);
                    });
                    
                    // Mark the file as failed
                    const message = this.createErrorMessage(stdout, stderr, child);
                    run.failed(child, message);
                }
                // Don't touch any other files - leave their previous state intact
            });
        } else {
            // Normal execution - mark all tests based on results
            parentTest.children.forEach(child => {
                run.started(child);

                // Check if this child has its own children (e.g., a file with methods)
                if (child.children.size > 0) {
                    // For file-level items, check if any of its methods ran
                    let fileHadResults = false;
                    let fileAllPassed = true;
                    let fileSomeFailed = false;
                    let fileRanCount = 0;
                    
                    child.children.forEach(methodTest => {
                        run.started(methodTest);

                        const methodName = this.extractMethodName(methodTest.id);
                        const result = testResults.get(methodName);
                        
                        if (result) {
                            fileHadResults = true;
                            foundAnyResults = true;
                            ranChildrenCount++;
                            fileRanCount++;
                            
                            if (result.passed) {
                                run.passed(methodTest);
                            } else {
                                fileAllPassed = false;
                                fileSomeFailed = true;
                                allChildrenPassed = false;
                                someChildrenFailed = true;
                                const message = this.createErrorMessage(stdout, stderr, methodTest, result.output);
                                run.failed(methodTest, message);
                            }
                        } else {
                            // Not mentioned in output -> assume success (Codeception only lists failures)
                            fileHadResults = true;
                            ranChildrenCount++;
                            fileRanCount++;
                            run.passed(methodTest);
                        }
                    });
                    
                    // Mark the file item based on its children's results
                    if (fileHadResults) {
                        // If ANY method failed, the file MUST be marked as failed
                        if (fileSomeFailed) {
                            const message = this.createErrorMessage(stdout, stderr, child);
                            run.failed(child, message);
                        } else if (fileAllPassed && fileRanCount === child.children.size) {
                            // Only mark file as passed if ALL its methods ran AND all passed
                            run.passed(child);
                        }
                        // If not all methods ran but none failed, don't mark the file
                        // (it will show no state, which is correct - incomplete run)
                    }
                    // If no methods ran, don't mark the file
                } else {
                    // Leaf node (method level) - check if it ran
                    const methodName = this.extractMethodName(child.id);
                    const result = testResults.get(methodName);

                    if (result) {
                        foundAnyResults = true;
                        ranChildrenCount++;
                        if (result.passed) {
                            run.passed(child);
                        } else {
                            allChildrenPassed = false;
                            someChildrenFailed = true;
                            const message = this.createErrorMessage(stdout, stderr, child, result.output);
                            run.failed(child, message);
                        }
                    } else {
                        // If the test isn't mentioned in the output, assume it succeeded
                        // (Codeception prints detailed info only for failing tests)
                        run.passed(child);
                        ranChildrenCount++;
                    }
                }
            });
        }

        // Mark parent test only if we found results
        // Parent should only be marked as passed if ALL its children that ran have passed
        if (foundAnyResults) {
            if (someChildrenFailed || hasFailures) {
                const message = this.createErrorMessage(stdout, stderr, parentTest);
                run.failed(parentTest, message);
            } else if (allChildrenPassed) {
                // Only mark parent as passed if ALL children ran
                const totalChildren = Array.from(parentTest.children).reduce((count, [_, child]) => {
                    return count + (child.children.size > 0 ? child.children.size : 1);
                }, 0);
                
                if (ranChildrenCount === totalChildren) {
                    run.passed(parentTest);
                }
                // If not all children ran, don't mark the parent
            }
        }
        // If no results found at all, don't mark the parent either
    }

    private parseTestResults(
        stdout: string,
        stderr: string
    ): Map<string, { passed: boolean; output?: string; file?: string }> {
        const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
        const lines = combinedOutput.split('\n');
        const results = new Map<string, { passed: boolean; output?: string; file?: string }>();
        let currentFile: string | undefined;

        // DEV: Uncomment for debugging
        // this.outputChannel.appendLine('[Codeception] Parsing test results from output...');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Track current file being tested (e.g., "tests/unit/SomeTest.php")
            const fileMatch = line.match(/^(tests\/[^\s]+\.php)/);
            if (fileMatch) {
                currentFile = fileMatch[1];
                // DEV: Uncomment for debugging
                // this.outputChannel.appendLine(`[Codeception] Found file: ${currentFile}`);
            }

            // Pattern 1: "✓ testMethodName" or "✗ testMethodName"
            const checkmarkMatch = line.match(/[✓✗]\s+(\w+)/);
            if (checkmarkMatch) {
                const passed = line.includes('✓');
                results.set(checkmarkMatch[1], {
                    passed: passed,
                    output: line,
                    file: currentFile
                });
                // DEV: Uncomment for debugging
                // this.outputChannel.appendLine(`[Codeception] Test ${checkmarkMatch[1]}: ${passed ? 'PASSED' : 'FAILED'}`);
                continue;
            }

            // Pattern 2: "testMethodName: OK|FAILED|PASSED|ERROR"
            const colonMatch = line.match(/(\w+):\s*(OK|FAILED|PASSED|ERROR)/i);
            if (colonMatch) {
                const passed = colonMatch[2].toUpperCase() === 'OK' || colonMatch[2].toUpperCase() === 'PASSED';
                results.set(colonMatch[1], {
                    passed: passed,
                    output: line,
                    file: currentFile
                });
                // DEV: Uncomment for debugging
                // this.outputChannel.appendLine(`[Codeception] Test ${colonMatch[1]}: ${passed ? 'PASSED' : 'FAILED'}`);
                continue;
            }

            // Pattern 3: "testMethodName (" followed by result on next line
            const parenMatch = line.match(/(\w+)\s*\(/);
            if (parenMatch && i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                const isSuccess = nextLine.includes('OK') || nextLine.includes('PASSED');
                const isFailure = nextLine.includes('FAILED') || nextLine.includes('FAILURE') || nextLine.includes('ERROR');
                
                if (isSuccess || isFailure) {
                    results.set(parenMatch[1], {
                        passed: isSuccess,
                        output: `${line}\n${nextLine}`,
                        file: currentFile
                    });
                    // DEV: Uncomment for debugging
                    // this.outputChannel.appendLine(`[Codeception] Test ${parenMatch[1]}: ${isSuccess ? 'PASSED' : 'FAILED'}`);
                }
                continue;
            }

            // Pattern 4: "Test  path:methodName" or "Test  path::methodName" (detailed error listing)
            // Codeception uses : for file path separator and method name
            const detailedErrorMatch = line.match(/Test\s+[^\s]+:([A-Za-z0-9_]+)/);
            if (detailedErrorMatch) {
                results.set(detailedErrorMatch[1], {
                    passed: false,
                    output: line,
                    file: currentFile
                });
                // DEV: Uncomment for debugging
                // this.outputChannel.appendLine(`[Codeception] Test ${detailedErrorMatch[1]}: FAILED (detailed report)`);
                continue;
            }
        }

        // DEV: Uncomment for debugging
        // this.outputChannel.appendLine(`[Codeception] Parsed ${results.size} test results`);
        return results;
    }

    private extractMethodName(testId: string): string {
        return testId.split('::').pop() || '';
    }

    private detectFatalError(stdout: string, stderr: string): boolean {
        // Check for PHP Fatal Error patterns in both stdout and stderr
        const fatalErrorPatterns = [
            /PHP Fatal Error/i,
            /PHP Fatal error:/i,
            /Fatal error:/i,
            /<pre>PHP Fatal/i
        ];

        const combinedOutput = stdout + '\n' + stderr;
        return fatalErrorPatterns.some(pattern => pattern.test(combinedOutput));
    }

    private extractFatalErrorInfo(stdout: string, stderr: string): { message: string; file?: string; line?: number } | null {
        const combinedOutput = stdout + '\n' + stderr;
        
        // Pattern 1: Match HTML formatted error from stdout
        // <pre>PHP Fatal Error 'yii\base\ErrorException' with message 'Trait "..." not found'
        const htmlErrorMatch = combinedOutput.match(
            /<pre>PHP Fatal (?:Error|error)[^']*'([^']*)'[^']*with message\s+'([^']*)'[^<]*in\s+([^\s:]+):(\d+)/i
        );
        
        if (htmlErrorMatch) {
            return {
                message: `${htmlErrorMatch[1]}: ${htmlErrorMatch[2]}`,
                file: htmlErrorMatch[3],
                line: parseInt(htmlErrorMatch[4], 10)
            };
        }

        // Pattern 2: Match plain text error from stderr
        // PHP Fatal error:  Trait "..." not found in /path/to/file.php on line 228
        const plainErrorMatch = combinedOutput.match(
            /PHP Fatal error:\s+(.+?)\s+in\s+([^\s]+)\s+on line\s+(\d+)/i
        );
        
        if (plainErrorMatch) {
            return {
                message: plainErrorMatch[1],
                file: plainErrorMatch[2],
                line: parseInt(plainErrorMatch[3], 10)
            };
        }

        // Pattern 3: Generic fatal error without location
        const genericErrorMatch = combinedOutput.match(/PHP Fatal (?:Error|error):\s+(.+?)(?:\n|$)/i);
        if (genericErrorMatch) {
            return {
                message: genericErrorMatch[1]
            };
        }

        return null;
    }

    private createErrorMessage(stdout: string, stderr: string, test: vscode.TestItem, fallbackMessage?: string): vscode.TestMessage {
        // Check if there's a fatal error
        const fatalErrorInfo = this.extractFatalErrorInfo(stdout, stderr);
        
        if (fatalErrorInfo) {
            const fullOutput = [stdout, stderr].filter(Boolean).join('\r\n\r\n');
            const message = new vscode.TestMessage(fullOutput || fatalErrorInfo.message);
            
            // If we have file and line information, add location to the message
            if (fatalErrorInfo.file && fatalErrorInfo.line !== undefined) {
                const fileUri = vscode.Uri.file(fatalErrorInfo.file);
                const position = new vscode.Position(fatalErrorInfo.line - 1, 0);
                message.location = new vscode.Location(fileUri, position);
            }
            
            return message;
        }
        
        // Fall back to regular error message
        const fullOutput = [stdout, stderr].filter(Boolean).join('\r\n\r\n');
        return new vscode.TestMessage(fullOutput || fallbackMessage || stderr || stdout);
    }

    /**
     * Check if an error is Docker-related
     */
    private isDockerError(errorMessage: string, stderr: string): boolean {
        const combinedError = `${errorMessage} ${stderr}`.toLowerCase();
        
        return combinedError.includes('docker') && (
            combinedError.includes('command not found') ||
            combinedError.includes('not recognized') ||
            combinedError.includes('cannot connect to the docker daemon') ||
            combinedError.includes('no such container') ||
            combinedError.includes('is not running') ||
            combinedError.includes('permission denied') ||
            combinedError.includes('enoent')
        );
    }

    /**
     * Get user-friendly Docker error message
     */
    private getDockerErrorMessage(errorMessage: string, stderr: string): string {
        const combinedError = `${errorMessage} ${stderr}`.toLowerCase();
        
        if (combinedError.includes('command not found') || 
            combinedError.includes('not recognized') ||
            combinedError.includes('enoent')) {
            return 'Docker command not found. Please ensure Docker is installed and in your PATH.';
        }
        
        if (combinedError.includes('cannot connect to the docker daemon')) {
            return 'Cannot connect to Docker daemon. Please ensure Docker Desktop or Docker service is running.';
        }
        
        if (combinedError.includes('no such container')) {
            return 'Container not found. The configured container may have stopped. Please select a running container.';
        }
        
        if (combinedError.includes('is not running')) {
            return 'Container is not running. Please start the container or select a different one.';
        }
        
        if (combinedError.includes('permission denied')) {
            return 'Permission denied accessing Docker. You may need to add your user to the docker group.';
        }
        
        return errorMessage;
    }

    private async debugTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
        // Debug implementation - would need Xdebug configuration
        vscode.window.showInformationMessage('Debug support coming soon!');
    }
}
