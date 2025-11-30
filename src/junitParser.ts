import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { JUnitTestResult } from './types';
import { DockerService } from './dockerService';

const parseStringAsync = promisify<string, any, any>(parseString);

/**
 * Parser for JUnit XML test result format
 * Handles parsing Codeception's --xml output for accurate test results
 */
export class JunitParser {
    private outputChannel: vscode.OutputChannel;
    private dockerService?: DockerService;

    constructor(outputChannel: vscode.OutputChannel, dockerService?: DockerService) {
        this.outputChannel = outputChannel;
        this.dockerService = dockerService;
    }

    /**
     * Parse JUnit XML file and extract test results
     * @param xmlPath Path to the JUnit XML file (typically tests/_output/report.xml)
     * @param containerPath Optional path inside Docker container (if Docker is enabled)
     * @param container Optional Docker container ID/name
     * @returns Map of test method names to their results
     */
    public async parseJUnitXml(
        xmlPath: string, 
        containerPath?: string, 
        container?: string
    ): Promise<Map<string, JUnitTestResult>> {
        const results = new Map<string, JUnitTestResult>();

        try {
            let xmlContent: string | null = null;

            // If Docker is enabled and we have container info, try reading from container first
            if (this.dockerService && container && containerPath) {
                this.outputChannel.appendLine(`[JunitParser] Attempting to read XML from Docker container: ${containerPath}`);
                xmlContent = await this.dockerService.readFileFromContainer(container, containerPath);
                
                if (xmlContent) {
                    this.outputChannel.appendLine(`[JunitParser] Successfully read XML from Docker container`);
                }
            }

            // Fall back to reading from host filesystem
            if (!xmlContent) {
                // Check if file exists on host
                if (!fs.existsSync(xmlPath)) {
                    this.outputChannel.appendLine(`[JunitParser] XML file not found: ${xmlPath}`);
                    return results;
                }

                // Read XML file from host
                xmlContent = await fs.promises.readFile(xmlPath, 'utf-8');
            }
            
            if (!xmlContent || xmlContent.trim().length === 0) {
                this.outputChannel.appendLine(`[JunitParser] XML file is empty: ${xmlPath}`);
                return results;
            }

            // Parse XML
            const parsedXml: any = await parseStringAsync(xmlContent, {
                explicitArray: false,
                mergeAttrs: true
            });

            // JUnit XML structure: testsuites > testsuite > testcase
            // Handle both single testsuite and multiple testsuites
            const testsuites = this.extractTestSuites(parsedXml);

            if (testsuites.length === 0) {
                this.outputChannel.appendLine(`[JunitParser] No test suites found in XML`);
                return results;
            }

            // Process each test suite
            for (const testsuite of testsuites) {
                if (!testsuite) continue;

                // Extract test cases from the suite
                const testcases = this.toArray(testsuite.testcase);

                for (const testcase of testcases) {
                    if (!testcase || !testcase.name) continue;

                    const result = this.parseTestCase(testcase, testsuite.name);
                    
                    // Store by method name for easy lookup
                    // Also store variations for matching
                    results.set(result.name, result);
                    
                    // Add lowercase version for case-insensitive matching
                    results.set(result.name.toLowerCase(), result);
                    
                    // Handle test prefix variations (testMethodName -> methodName)
                    if (result.name.toLowerCase().startsWith('test')) {
                        const withoutTest = result.name.substring(4);
                        results.set(withoutTest, result);
                        results.set(withoutTest.toLowerCase(), result);
                    }
                }
            }

            this.outputChannel.appendLine(`[JunitParser] Parsed ${results.size / 2} test results from XML`);

        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            this.outputChannel.appendLine(`[JunitParser] ERROR parsing XML: ${errorMessage}`);
        }

        return results;
    }

    /**
     * Extract test suites from parsed XML
     * Handles both single and multiple testsuite structures
     */
    private extractTestSuites(parsedXml: any): any[] {
        // Try testsuites wrapper first (standard JUnit format)
        if (parsedXml.testsuites) {
            const suites = this.toArray(parsedXml.testsuites.testsuite);
            if (suites.length > 0) {
                return suites;
            }
        }

        // Try direct testsuite element (some formats)
        if (parsedXml.testsuite) {
            return this.toArray(parsedXml.testsuite);
        }

        return [];
    }

    /**
     * Parse individual test case element
     */
    private parseTestCase(testcase: any, suiteName?: string): JUnitTestResult {
        const result: JUnitTestResult = {
            name: testcase.name,
            className: testcase.classname || testcase.class || suiteName,
            status: 'passed',
            time: testcase.time ? parseFloat(testcase.time) : undefined
        };

        // Check for failure
        if (testcase.failure) {
            result.status = 'failed';
            result.failure = this.parseFailureOrError(testcase.failure);
        }

        // Check for error
        if (testcase.error) {
            result.status = 'error';
            result.error = this.parseFailureOrError(testcase.error);
        }

        // Check for skipped
        if (testcase.skipped) {
            result.status = 'skipped';
        }

        return result;
    }

    /**
     * Parse failure or error element
     */
    private parseFailureOrError(element: any): { message: string; type: string; content: string } {
        // Handle both string content and object with attributes
        if (typeof element === 'string') {
            return {
                message: element,
                type: 'AssertionError',
                content: element
            };
        }

        return {
            message: element.message || element._ || '',
            type: element.type || 'Error',
            content: element._ || element.message || ''
        };
    }

    /**
     * Convert value to array (handles xml2js inconsistency)
     */
    private toArray<T>(value: T | T[] | undefined): T[] {
        if (!value) {
            return [];
        }
        return Array.isArray(value) ? value.filter(Boolean) as T[] : [value];
    }

    /**
     * Get the default JUnit XML output path for Codeception
     */
    public static getDefaultXmlPath(workspaceRoot: string): string {
        return `${workspaceRoot}/tests/_output/report.xml`;
    }
}

