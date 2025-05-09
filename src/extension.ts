import * as vscode from 'vscode';
import { IpynbSlideProvider } from './editor/ipynbSlideProvider';

// This method is called when your extension is activated.
// Your extension is activated the very first time a command is executed
// or when a CustomEditorProvider matching a file type is triggered.
export function activate(context: vscode.ExtensionContext) {

    console.log('[Extension] "ipynb-slide-preview" is now active!');

    // Register the Custom Editor Provider for .ipynb files.
    // This allows the extension to take over rendering for these files
    // with the 'ipynb.slidePreview' view type.
    context.subscriptions.push(IpynbSlideProvider.register(context));

    // Register the command that allows users to explicitly open the custom editor.
    // This is useful if they have a default editor for .ipynb files but want to use the slide preview.
    context.subscriptions.push(vscode.commands.registerCommand('ipynb-slide-preview.open', () => {
        const activeEditor = vscode.window.activeTextEditor;

        if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.ipynb')) {
            // If an .ipynb file is already open and active, open it with our custom editor.
            vscode.commands.executeCommand('vscode.openWith', activeEditor.document.uri, 'ipynb.slidePreview');
        } else {
            // If no .ipynb file is active, inform the user.
            // Optionally, you could prompt them to open an .ipynb file here.
            vscode.window.showWarningMessage('Please open an .ipynb file first to use the "Open with IPYNB Slide Editor" command.');
        }
    }));
}

// This method is called when your extension is deactivated (e.g., VS Code closing, extension disabled/uninstalled)
export function deactivate() {
    // Perform any cleanup tasks here if necessary
    console.log('[Extension] "ipynb-slide-preview" is now deactivated.');
}