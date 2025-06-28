import * as vscode from 'vscode';
import { IpynbSlideDocument } from './ipynbSlideDocument';
import { getNonce } from './util';
import { DocumentManager } from './documentManager';
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';


const WORKSPACE_STATE_PREFIX = 'ipynbSlidePreview.currentSlideIndex:';

export class IpynbSlideProvider implements vscode.CustomEditorProvider<IpynbSlideDocument> {

    // --- Emitter and event for the Provider ---
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    // --- Map to store disposables for document edit listeners ---
    private readonly documentEditListeners = new Map<string, vscode.Disposable>();

    private readonly documentWebviews = new Map<string, Set<vscode.WebviewPanel>>();

    private readonly documentManagers = new WeakMap<IpynbSlideDocument, DocumentManager>();


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

        const strategy = new BackgroundNotebookProxyStrategy(document.uri,  document.getNotebookData());
        // Pass the document along with the strategy
        const docManager = new DocumentManager(document, strategy);
        await docManager.initialize();
        this.documentManagers.set(document, docManager);

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

        // If a listener for this document's edits already exists (e.g., re-opening), dispose of it.
        this.documentEditListeners.get(document.uri.toString())?.dispose();

        const editListener = document.onDidChangeCustomDocument(event => {
            // When the document fires its edit event, the provider relays it.
            console.log(`[Provider] Relaying onDidChangeCustomDocument event from document ${event.document.uri.fsPath}. Label: ${event.label}`);
            this._onDidChangeCustomDocument.fire(event); // Fire the provider's event
        });
        this.documentEditListeners.set(document.uri.toString(), editListener);
        
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
            console.log(`[Provider] Message received from webview: ${message.type}`, message.payload ?? '');
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
                        const docManager = this.documentManagers.get(document);
                        docManager?.runCell(message.payload.slideIndex);
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
                case 'cellContentChanged':
                    if (message.payload &&
                        typeof message.payload.slideIndex === 'number' &&
                        typeof message.payload.newSource === 'string') { // Or handle string[] if Monaco gives that
                        console.log(`[Provider] Received cellContentChanged for index ${message.payload.slideIndex}`);
                        document.updateCellSource( // We'll define this temporary method next
                            message.payload.slideIndex,
                            message.payload.newSource
                        );
                    } else {
                        console.warn('[Provider] Invalid payload for cellContentChanged message:', message.payload);
                    }
                    break;
                case 'requestGlobalUndo':
                    console.log('[Provider] Received requestGlobalUndo from webview.');
                    vscode.commands.executeCommand('undo');
                    break;
                case 'requestGlobalRedo':
                    console.log('[Provider] Received requestGlobalRedo from webview.');
                    vscode.commands.executeCommand('redo');
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

                const documentManager = this.documentManagers.get(document);
                if (documentManager) {
                    console.log(`[Provider] Disposing NotebookManager for document: ${document.uri.fsPath}`);
                    documentManager.dispose();
                    this.documentManagers.delete(document);
                }

                console.log(`[Provider] Disposing edit listener for document: ${uriString}`);
                this.documentEditListeners.get(uriString)?.dispose();
                this.documentEditListeners.delete(uriString);        
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

        const manager = this.documentManagers.get(document);
        const controllerName = 'Select Kernel';
    
        console.log(`[Provider] Sending slide ${document.currentSlideIndex} to webview for ${document.uri.fsPath}. Lang: ${notebookLanguage}`);
        webviewPanel.webview.postMessage({
            type: 'update',
            payload: {
                slideIndex: document.currentSlideIndex,
                totalSlides: document.cells.length,
                cell: currentSlideData,
                notebookLanguage: notebookLanguage,
                controllerName: controllerName
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
            <div id="main-toolbar">
                <div class="toolbar-actions-left">
                    </div>
                <div class="toolbar-spacer"></div>
                <div class="toolbar-actions-right">
                    <div id="kernel-status-container">
                        <span id="kernel-indicator-icon"></span>
                        <span id="kernel-indicator-name">Not Selected</span>
                    </div>
                </div>
            </div>
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
}