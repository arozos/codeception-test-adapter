import * as vscode from 'vscode';
import { CodeceptionTestProvider } from './testProvider';
import { DockerService } from './dockerService';
import { CoverageManager } from './coverageManager';

// Global output channel for the extension
export let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    // Create dedicated output channel
    outputChannel = vscode.window.createOutputChannel('Codeception Test Explorer');
    context.subscriptions.push(outputChannel);
    
    outputChannel.appendLine('Codeception Test Explorer - Extension Activated');

    // Create the test controller
    const testController = vscode.tests.createTestController(
        'codeceptionTestController',
        'Codeception Tests'
    );

    context.subscriptions.push(testController);

    // Initialize coverage manager
    const coverageManager = new CoverageManager(outputChannel);
    context.subscriptions.push(coverageManager);

    try {
        // Create and register the test provider
        const testProvider = new CodeceptionTestProvider(testController, outputChannel, coverageManager);
        
        // Register the test provider for disposal
        context.subscriptions.push({
            dispose: () => testProvider.dispose()
        });
        
        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('codeceptionphp.refreshTests', async () => {
                await testProvider.discoverTests();
            }),
            vscode.commands.registerCommand('codeceptionphp.runFromDocker', async () => {
                await handleDockerContainerSelection(outputChannel, testProvider);
            })
        );

        // Initial test discovery
        testProvider.discoverTests();
    } catch (error: any) {
        outputChannel.appendLine(`[ERROR] Failed to initialize test provider: ${error.message}`);
        outputChannel.appendLine(error.stack || '');
        vscode.window.showErrorMessage(`Codeception Test Explorer failed to start: ${error.message}`);
    }
}

/**
 * Handle Docker container selection command
 */
async function handleDockerContainerSelection(
    outputChannel: vscode.OutputChannel,
    testProvider: CodeceptionTestProvider
): Promise<void> {
    try {
        const dockerService = new DockerService(outputChannel);
        
        // First check if Docker is available
        const dockerCheck = await dockerService.isDockerAvailable();
        if (!dockerCheck.available) {
            vscode.window.showErrorMessage(
                `Docker Not Found: ${dockerCheck.error}`,
                'View Output'
            ).then(selection => {
                if (selection === 'View Output') {
                    outputChannel.show();
                }
            });
            return;
        }
        
        const containers = await dockerService.listRunningContainers();

        if (containers.length === 0) {
            vscode.window.showWarningMessage(
                'No running Docker containers found. Please start a container and try again.',
                'View Output'
            ).then(selection => {
                if (selection === 'View Output') {
                    outputChannel.show();
                }
            });
            return;
        }

        // Create QuickPick items
        const items = containers.map(container => ({
            label: container.name || container.id,
            description: `${container.image} - ${container.status}`,
            detail: `ID: ${container.id}`,
            container: container,
        }));

        // Show QuickPick
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Docker container to run Codeception tests',
            title: 'Select Docker Container',
        });

        if (!selected) {
            return;
        }

        // Detect working directory inside the container
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const containerWorkdir = await dockerService.getContainerWorkingDirectory(
            selected.container.name || selected.container.id,
            workspaceRoot
        );

        // Update configuration
        const config = vscode.workspace.getConfiguration('codeceptionphp');
        await config.update('docker.enabled', true, vscode.ConfigurationTarget.Workspace);
        await config.update('docker.container', selected.container.name || selected.container.id, vscode.ConfigurationTarget.Workspace);
        await config.update('docker.workdir', containerWorkdir, vscode.ConfigurationTarget.Workspace);

        vscode.window.showInformationMessage(
            `Codeception tests will now run in Docker container: ${selected.container.name || selected.container.id}\nWorking directory: ${containerWorkdir}`,
            'OK'
        );

        // Refresh test discovery
        await testProvider.discoverTests();
    } catch (error: any) {
        const errorMessage = error?.message || String(error);
        outputChannel.appendLine(`ERROR selecting Docker container: ${errorMessage}`);
        if (error?.stack) {
            outputChannel.appendLine(error.stack);
        }
        
        // Show user-friendly error with option to view logs
        vscode.window.showErrorMessage(
            `Docker Error: ${errorMessage}`,
            'View Output',
            'Dismiss'
        ).then(selection => {
            if (selection === 'View Output') {
                outputChannel.show();
            }
        });
    }
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}
