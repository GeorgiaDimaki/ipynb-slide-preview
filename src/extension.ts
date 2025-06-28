import * as vscode from 'vscode';
import { IpynbSlideProvider } from './editor/ipynbSlideProvider';

// For now, it is unused.
export let extensionId: string;

// This method is called when your extension is activated.
export function activate(context: vscode.ExtensionContext) {

    console.log('[Extension] "ipynb-slide-preview" is now active!');
    
    extensionId = context.extension.id;

    // Register the Custom Editor Provider for .ipynb files.
    context.subscriptions.push(IpynbSlideProvider.register(context));

    // Register the command that allows users to explicitly open the custom editor.
    context.subscriptions.push(vscode.commands.registerCommand('ipynb-slide-preview.open', () => {
        const activeEditor = vscode.window.activeTextEditor;

        if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.ipynb')) {
            // If an .ipynb file is already open and active, open it with our custom editor.
            vscode.commands.executeCommand('vscode.openWith', activeEditor.document.uri, 'ipynb.slidePreview');
        } else {
            // If no .ipynb file is active, inform the user.
            vscode.window.showWarningMessage('Please open an .ipynb file first to use the "Open with IPYNB Slide Editor" command.');
        }
    }));
}

// This method is called when your extension is deactivated
export function deactivate() {
    // Perform any cleanup tasks here if necessary
    console.log('[Extension] "ipynb-slide-preview" is now deactivated.');
}