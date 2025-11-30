import * as fs from 'fs';
import * as vscode from 'vscode';
import { Engine } from 'php-parser';
import { TestMethod, ParsedTestFile } from './types';

/**
 * PHP AST Parser for Codeception test discovery
 * Parses PHP files to extract test methods, annotations, and accurate line numbers
 */
export class PhpTestParser {
    private parser: InstanceType<typeof Engine>;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        
        try {
            // Configure parser with docblock extraction and position information
            this.parser = new Engine({
                parser: {
                    extractDoc: true,
                    php7: true,
                },
                ast: {
                    withPositions: true,
                },
            });
        } catch (error: any) {
            this.outputChannel.appendLine(`ERROR: Failed to initialize PHP parser: ${error.message}`);
            throw error;
        }
    }

    /**
     * Parse a PHP test file and extract test methods with annotations
     */
    public parseTestFile(filePath: string): ParsedTestFile {
        try {
            if (!fs.existsSync(filePath)) {
                return { methods: [] };
            }

            const fileContent = fs.readFileSync(filePath, 'utf-8');
            
            // Skip empty files
            if (!fileContent.trim()) {
                return { methods: [] };
            }

            // DEV: Uncomment for debugging
            // this.outputChannel.appendLine(`[PhpParser] Parsing file (${fileContent.length} bytes): ${filePath}`);
            
            const ast = this.parser.parseCode(fileContent, filePath);

            // Validate AST structure
            if (!ast) {
                return { methods: [] };
            }

            const result: ParsedTestFile = {
                methods: [],
            };

            // Traverse AST to find classes and methods
            this.traverseAST(ast, result);

            return result;
        } catch (error: any) {
            // If AST parsing fails, return empty result
            // The caller can fall back to regex parsing
            // DEV: Uncomment for debugging
            // const errorMessage = error?.message || String(error);
            // this.outputChannel.appendLine(`[PhpParser] ERROR parsing ${filePath}: ${errorMessage}`);
            return {
                methods: [],
            };
        }
    }

    /**
     * Recursively traverse AST nodes to find classes and test methods
     */
    private traverseAST(node: any, result: ParsedTestFile): void {
        if (!node || typeof node !== 'object') {
            return;
        }

        // Handle class declaration
        if (node.kind === 'class' || node.kind === 'classinterface') {
            if (node.name) {
                result.className = node.name.name || node.name;
            }

            // Process class body for methods
            if (node.body && Array.isArray(node.body)) {
                for (const child of node.body) {
                    if (child.kind === 'method') {
                        const testMethod = this.parseMethod(child);
                        if (testMethod) {
                            result.methods.push(testMethod);
                        }
                    }
                }
            }
        }

        // Recursively process child nodes
        if (node.children && Array.isArray(node.children)) {
            for (const child of node.children) {
                this.traverseAST(child, result);
            }
        }

        // Also check for statements array (top-level statements)
        if (node.children === undefined && Array.isArray(node)) {
            for (const child of node) {
                this.traverseAST(child, result);
            }
        }

        // Handle program node (root of AST)
        if (node.kind === 'program' && node.children) {
            for (const child of node.children) {
                this.traverseAST(child, result);
            }
        }
    }

    /**
     * Parse a method node and extract test information
     */
    private parseMethod(methodNode: any): TestMethod | null {
        // Only process public methods
        if (methodNode.visibility !== 'public' && methodNode.visibility !== undefined) {
            return null;
        }

        const methodName = methodNode.name?.name || methodNode.name;
        if (!methodName) {
            return null;
        }

        // Skip constructor and lifecycle methods
        if (methodName === '__construct' || methodName.startsWith('_')) {
            return null;
        }

        // Extract docblock annotations
        // php-parser stores docblocks in different places depending on version
        let docblock = '';
        if (methodNode.leadingComments && methodNode.leadingComments.length > 0) {
            const comment = methodNode.leadingComments[0];
            if (comment.kind === 'commentblock' || comment.kind === 'comment') {
                docblock = comment.value || '';
            }
        }
        if (!docblock && methodNode.doc) {
            if (methodNode.doc.kind === 'commentblock' || methodNode.doc.kind === 'comment') {
                docblock = methodNode.doc.value || '';
            }
        }
        
        const annotations = this.parseAnnotations(docblock, methodName);

        // Only include methods that are tests
        if (!annotations.isTest) {
            return null;
        }

        // Extract line numbers
        // php-parser uses 'loc' property for location information
        const line = methodNode.loc?.start?.line || 1;
        const endLine = methodNode.loc?.end?.line || line;

        return {
            name: methodName,
            line,
            endLine,
            annotations,
        };
    }

    /**
     * Parse docblock annotations
     */
    private parseAnnotations(docblock: string, methodName: string): TestMethod['annotations'] {
        const annotations: TestMethod['annotations'] = {
            isTest: false,
        };

        if (!docblock) {
            // If no docblock, check if method name starts with 'test'
            annotations.isTest = methodName.toLowerCase().startsWith('test');
            return annotations;
        }

        // Check for @test annotation
        const hasTestAnnotation = /@test\b/i.test(docblock);
        const startsWithTest = methodName.toLowerCase().startsWith('test');

        annotations.isTest = hasTestAnnotation || startsWithTest;

        // Extract @dataProvider annotation
        const dataProviderMatch = docblock.match(/@dataProvider\s+(\w+)/i);
        if (dataProviderMatch) {
            annotations.dataProvider = dataProviderMatch[1];
        }

        // Extract @depends annotations (can have multiple)
        const dependsMatches = docblock.match(/@depends\s+(\w+)/gi);
        if (dependsMatches) {
            annotations.depends = dependsMatches.map(match => {
                const methodMatch = match.match(/@depends\s+(\w+)/i);
                return methodMatch ? methodMatch[1] : '';
            }).filter(Boolean);
        }

        // Extract @group annotations (can have multiple)
        const groupMatches = docblock.match(/@group\s+(\w+)/gi);
        if (groupMatches) {
            annotations.groups = groupMatches.map(match => {
                const groupMatch = match.match(/@group\s+(\w+)/i);
                return groupMatch ? groupMatch[1] : '';
            }).filter(Boolean);
        }

        return annotations;
    }
}

