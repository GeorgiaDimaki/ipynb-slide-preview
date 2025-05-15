import * as vscode from 'vscode';
import { IpynbSlideDocument } from './ipynbSlideDocument';
import { getNonce } from './util';

const WORKSPACE_STATE_PREFIX = 'ipynbSlidePreview.currentSlideIndex:';

export class IpynbSlideProvider implements vscode.CustomEditorProvider<IpynbSlideDocument> {

    private readonly documentWebviews = new Map<string, Set<vscode.WebviewPanel>>();

    constructor(private readonly context: vscode.ExtensionContext) { }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new IpynbSlideProvider(context);
        return vscode.window.registerCustomEditorProvider(
            'ipynb.slidePreview',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: false,
                    enableFindWidget: false,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<IpynbSlideDocument> {
        console.log(`[Provider] Opening document: ${uri.fsPath}`);
        const backupUri = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
        const fileData: Uint8Array = await vscode.workspace.fs.readFile(backupUri);
        const document = new IpynbSlideDocument(uri, fileData);

        // Restore slide index early, before listeners are attached that might depend on it
        const workspaceStateKey = `${WORKSPACE_STATE_PREFIX}${document.uri.toString()}`;
        const restoredIndex = this.context.workspaceState.get<number>(workspaceStateKey);

        if (typeof restoredIndex === 'number') {
            if (restoredIndex >= 0 && restoredIndex < document.cells.length) {
                document.currentSlideIndex = restoredIndex;
                console.log(`[Provider] Restored slide index for ${document.uri.fsPath} from workspaceState to: ${document.currentSlideIndex}`);
            } else if (document.cells.length > 0) {
                document.currentSlideIndex = 0; // Default to 0 if out of bounds
                console.log(`[Provider] workspaceState index ${restoredIndex} out of bounds for ${document.uri.fsPath}. Defaulting to 0.`);
            } else {
                document.currentSlideIndex = 0; // No cells
                console.log(`[Provider] No cells in ${document.uri.fsPath}. Defaulting index to 0.`);
            }
        } else {
            // No saved state, document initializes to 0 by default
            console.log(`[Provider] No workspaceState found for slide index of ${document.uri.fsPath}. Document will use default index 0.`);
        }
        const changeListener = document.onDidChangeContent(() => {
            this.updateAllWebviewsForDocument(document);
            const newWorkspaceStateKey = `${WORKSPACE_STATE_PREFIX}${document.uri.toString()}`;
            console.log(`[Provider] Saving slide index ${document.currentSlideIndex} to workspaceState for ${newWorkspaceStateKey}`);
            this.context.workspaceState.update(newWorkspaceStateKey, document.currentSlideIndex);
        });
        document.setContentChangeListener(changeListener);

        return document;
    }

    async resolveCustomEditor(
        document: IpynbSlideDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        console.log(`[Provider] Resolving editor for: ${document.uri.fsPath}`);

        const uriString = document.uri.toString();
        if (!this.documentWebviews.has(uriString)) {
            this.documentWebviews.set(uriString, new Set());
        }
        this.documentWebviews.get(uriString)?.add(webviewPanel);

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                // If Monaco workers are in a different subfolder of media, add that path too
                // vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workers')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(message => {
            console.log(`[Provider] Message received from webview: ${message.type}`, message.payload);
            switch (message.type) {
                case 'ready':
                    this.updateWebviewContent(document, webviewPanel);
                    break;
                case 'previous':
                    document.currentSlideIndex--;
                    break;
                case 'next':
                    document.currentSlideIndex++;
                    break;
                case 'runCell':
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        document.runCell(message.payload.slideIndex);
                    } else {
                        console.warn('[Provider] Invalid payload for runCell message:', message.payload);
                    }
                    break;
                case 'deleteCell': // This might be triggered if requestDeleteConfirmation is bypassed
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        document.deleteCell(message.payload.slideIndex);
                    } else {
                        console.warn('[Provider] Invalid payload for deleteCell message:', message.payload);
                    }
                    break;
                case 'requestDeleteConfirmation':
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        const slideIndex = message.payload.slideIndex;
                        vscode.window.showWarningMessage(
                            `Are you sure you want to delete slide ${slideIndex + 1}?`,
                            { modal: true },
                            "Delete"
                        ).then(selection => {
                            if (selection === "Delete") {
                                console.log(`[Provider] User confirmed deletion for slide: ${slideIndex}`);
                                document.deleteCell(slideIndex);
                            } else {
                                console.log(`[Provider] User cancelled deletion for slide: ${slideIndex}`);
                            }
                        });
                    } else {
                        console.warn('[Provider] Invalid payload for requestDeleteConfirmation message:', message.payload);
                    }
                    break;
                case 'addCellBefore':
                    if (message.payload &&
                        typeof message.payload.currentSlideIndex === 'number' &&
                        (message.payload.cellType === 'markdown' || message.payload.cellType === 'code')) {
                        document.addCellBefore(message.payload.currentSlideIndex, message.payload.cellType);
                    } else {
                        console.warn('[Provider] Invalid payload for addCellBefore message:', message.payload);
                    }
                    break;
                case 'addCellAfter':
                    if (message.payload &&
                        typeof message.payload.currentSlideIndex === 'number' &&
                        (message.payload.cellType === 'markdown' || message.payload.cellType === 'code')) {
                        document.addCellAfter(message.payload.currentSlideIndex, message.payload.cellType);
                    } else {
                        console.warn('[Provider] Invalid payload for addCellAfter message:', message.payload);
                    }
                    break;
                default:
                    console.warn('[Provider] Received unknown message type from webview:', message.type);
            }
        });

        webviewPanel.onDidDispose(() => {
            console.log(`[Provider] Disposing webview panel for: ${document.uri.fsPath}`);
            const webviewSet = this.documentWebviews.get(uriString);
            webviewSet?.delete(webviewPanel);
            if (webviewSet?.size === 0) {
                this.documentWebviews.delete(uriString);
                // VS Code handles document disposal based on its lifetime rules,
                // especially since supportsMultipleEditorsPerDocument is false.
            }
        });
    }

    private updateAllWebviewsForDocument(document: IpynbSlideDocument): void {
        const webviews = this.documentWebviews.get(document.uri.toString());
        webviews?.forEach(panel => this.updateWebviewContent(document, panel));
    }

    private updateWebviewContent(document: IpynbSlideDocument, webviewPanel: vscode.WebviewPanel): void {
        const currentSlideData = document.getCurrentSlideData();
        const notebookMetadata = document.getNotebookMetadata();
        const notebookLanguage = (notebookMetadata?.language_info?.name || notebookMetadata?.kernelspec?.language || 'plaintext').toLowerCase();

        console.log(`[Provider] Sending slide ${document.currentSlideIndex} to webview for ${document.uri.fsPath}. Lang: ${notebookLanguage}`);
        webviewPanel.webview.postMessage({
            type: 'updateSlide',
            payload: {
                slideIndex: document.currentSlideIndex,
                totalSlides: document.cells.length,
                cell: currentSlideData,
                notebookLanguage: notebookLanguage
            }
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.css')); 
        const monacoStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.main.css')); // If using manual Monaco CSS copy

        const nonce = getNonce();

        const csp = `
            default-src 'none';
            script-src 'nonce-${nonce}' ${webview.cspSource};
            style-src ${webview.cspSource} 'unsafe-inline';
            font-src ${webview.cspSource};
            img-src ${webview.cspSource} data: https:;
            worker-src ${webview.cspSource} blob:;
            connect-src ${webview.cspSource};
        `;
        // Removed the duplicate getHtmlForWebview_ method.
        // Make sure the script tag does not have type="module" if esbuild format is 'iife'
        return /*html*/`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="${csp.replace(/\n\s*/g, ' ').trim()}">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>IPYNB Slide Preview</title>
                <link href="${styleUri}" rel="stylesheet" />
                <link href="${monacoStyleUri}" rel="stylesheet" data-name="vs/editor/editor.main" />
            </head>
            <body>
            <div id="main-view-wrapper">
                <div id="add-slide-left-container" class="side-add-slide-container">
                    <button id="add-slide-left-button" class="side-add-button" title="Add slide before current">+</button>
                </div>

                <div id="slide-content">  <p>Loading slide content...</p>
                </div>

                <div id="add-slide-right-container" class="side-add-slide-container">
                    <button id="add-slide-right-button" class="side-add-button" title="Add slide after current">+</button>
                </div>
            </div>

            <div id="controls">
                <button id="prev-button">Previous</button>
                <span id="slide-indicator"></span>
                <button id="next-button">Next</button>
            </div>

            <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    async saveCustomDocument(document: IpynbSlideDocument, cancellation: vscode.CancellationToken): Promise<void> {
        await document.save(cancellation);
    }

    async saveCustomDocumentAs(document: IpynbSlideDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        await document.saveAs(destination, cancellation);
    }

    async revertCustomDocument(document: IpynbSlideDocument, cancellation: vscode.CancellationToken): Promise<void> {
        await document.revert(cancellation);
    }

    async backupCustomDocument(document: IpynbSlideDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return await document.backup(context.destination, cancellation);
    }

    // This onDidChangeCustomDocument is essential for VS Code to enable undo/redo & dirty indicators
    // It should ideally be driven by the document itself.
    // For now, if your document's _onDidChangeDocument is public as onDidChangeCustomDocument, that's good.
    // If IpynbSlideDocument.onDidChangeCustomDocument is the event emitter, use that.
    // Let's assume we need to manage it per document if multiple are open,
    // but since supportsMultipleEditorsPerDocument is false, we can simplify.
    // A proper implementation here would involve creating an event emitter in the provider
    // that listens to document.onDidChangeCustomDocument for the *active* or *relevant* document.
    // For simplicity in a single-document-per-editor scenario, this might just forward
    // from a known document, but that's not robust.
    // The most correct way if not forwarding directly from the document instance:
    private _onDidChangCustomDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>();
    get onDidChangeCustomDocument(): vscode.Event<vscode.CustomDocumentEditEvent<IpynbSlideDocument>> {
        // In a real scenario, when document.onDidChangeCustomDocument fires,
        // you'd fire this provider's emitter.
        // For now, if the document itself has 'public readonly onDidChangeCustomDocument',
        // VS Code might pick that up if the provider instance exposes it correctly,
        // but the API expects the provider to have this property.
        //
        // Simplest for now, assuming edits are handled by _onDidChangeContent re-rendering:
        // To actually enable VS Code's native undo/redo for your document edits,
        // the document.deleteCell (and other editing methods) MUST fire
        // document._onDidChangeDocument correctly, and this getter should return
        // an event that VS Code listens to.
        //
        // If IpynbSlideDocument has `public readonly onDidChangeCustomDocument = this._onDidChangeDocument.event;`
        // and you have access to the specific `document` instance for which this event is being requested,
        // you could return `document.onDidChangeCustomDocument;`. But this getter is general for the provider.
        //
        // A common pattern:
        // When a document is opened/resolved, subscribe to its onDidChangeCustomDocument
        // and have it fire this provider's emitter. Unsubscribe on dispose.
        // For now, this is a placeholder that won't enable undo/redo via VS Code's UI based on this event.
        // Undo/redo for cell deletion is currently handled by the CustomDocumentEditEvent in deleteCell.
        return this._onDidChangCustomDocumentEmitter.event;
    }
}