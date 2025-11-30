/**
 * Type definitions for AST-based PHP test parsing
 */

export interface TestMethod {
    name: string;
    line: number;
    endLine: number;
    annotations: {
        isTest: boolean;
        dataProvider?: string;
        depends?: string[];
        groups?: string[];
    };
}

export interface ParsedTestFile {
    className?: string;
    methods: TestMethod[];
}

/**
 * Coverage-related type definitions
 */
export interface FileCoverageData {
    filePath: string;
    lines: LineCoverage[];
}

export interface LineCoverage {
    lineNumber: number;
    executionCount: number;
}

export interface CoverageParseResult {
    files: Map<string, FileCoverageData>;
    summary: {
        totalLines: number;
        coveredLines: number;
        percentage: number;
    };
}

/**
 * JUnit XML test result type definitions
 */
export interface JUnitTestResult {
    name: string;
    className?: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
    time?: number;
    failure?: {
        message: string;
        type: string;
        content: string;
    };
    error?: {
        message: string;
        type: string;
        content: string;
    };
}

