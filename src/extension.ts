import * as vscode from 'vscode';
import { IpynbSlideProvider } from './editor/ipynbSlideProvider';

/**
 * The unique identifier for this extension, retrieved from the extension context.
 * For now, it is unused.
 */
export let extensionId: string;

/**
 * The main entry point for the extension. This function is called by VS Code
 * when the extension is activated. Activation occurs the very first time a
 * command is executed or an activation event is triggered.
 *
 * @param context The extension context provided by VS Code, which contains
 * utilities and lifecycle management APIs.
 */
export function activate(context: vscode.ExtensionContext) {

    console.log('[Extension] "ipynb-slide-preview" is now active!');
    
    extensionId = context.extension.id;

    // Register the Custom Editor Provider for .ipynb files.
    context.subscriptions.push(IpynbSlideProvider.register(context));

    // Register the command that allows users to explicitly open the custom editor.
    context.subscriptions.push(vscode.commands.registerCommand('ipynb-slide-preview.open', () => {
        const activeEditor = vscode.window.activeNotebookEditor;

        if (activeEditor && activeEditor.notebook.uri.fsPath.endsWith('.ipynb')) {
            // If an .ipynb file is already open and active, open it with our custom editor.
            vscode.commands.executeCommand('vscode.openWith', activeEditor.notebook.uri, 'ipynb.slidePreview');
        } else {
            // If no .ipynb file is active, inform the user.
            vscode.window.showWarningMessage('Please open an .ipynb file first to use the "Open with IPYNB Slide Editor" command.');
        }
    }));
}

/**
 * This function is called when the extension is deactivated.
 * It's the place to perform any cleanup tasks.
 */
export function deactivate() {
    // Perform any cleanup tasks here if necessary
    console.log('[Extension] "ipynb-slide-preview" is now deactivated.');
}