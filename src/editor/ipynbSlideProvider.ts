import * as vscode from 'vscode';
import { IpynbSlideDocument } from './ipynbSlideDocument';
import { getNonce } from './util';
import { DocumentManager } from './documentManager';
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';
import { ISpecModel } from '@jupyterlab/services/lib/kernelspec/restapi';
import { SlidePayload } from '../webviews/types';
import * as path from 'path';


const WORKSPACE_STATE_PREFIX = 'ipynbSlidePreview.currentSlideIndex:';
const PYTHON_PATH_KEY_PREFIX = 'ipynbSlidePreview.pythonPath:';

interface KernelQuickPickItem extends vscode.QuickPickItem {
    kernelName: string; // The internal kernel name, e.g., 'python3'
    pythonPath: string;
}

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

        // 1. Get the key for this specific document's saved Python path.
        const pythonPathKey = `${PYTHON_PATH_KEY_PREFIX}${document.uri.toString()}`;

        // 2. Retrieve the saved path from workspace state. It might be undefined.
        const savedPythonPath = this.context.workspaceState.get<string>(pythonPathKey);
        console.log(`[Provider] Found saved Python path for this document: ${savedPythonPath}`);

        const strategy = new BackgroundNotebookProxyStrategy(document.uri,  document.getNotebookData(), savedPythonPath);
        // Pass the document along with the strategy
        const docManager = new DocumentManager(document, strategy);

        try {
            // We still attempt to initialize automatically...
            await docManager.initialize();
        } catch (e) {
            // ...but if it fails, we catch the error and log it.
            // We DON'T re-throw it. This allows the editor to open.
            // The user has already been shown a specific error message by the strategy.
            console.error(`[Provider] Initial kernel startup failed. The user can select a kernel manually.`, e);
        }

        this.documentManagers.set(document, docManager);
        docManager.onKernelChanged(() => {
            console.log('[Provider] Kernel change detected from strategy. Updating webviews.');
            this.updateAllWebviewsForDocument(document);
        });

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

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            console.log(`[Provider] Message received from webview: ${message.type}`, message.payload ?? '');
            const docManager = this.documentManagers.get(document);
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
                // ---  Toolbar Actions ---
                case 'runCell':
                    // It's still good practice to validate the payload from the webview
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        docManager?.runCell(message.payload.slideIndex);
                    }
                    break;
                case 'runAll':
                    docManager?.runAllCells();
                    break;
                case 'restartKernel':
                    docManager?.restartKernel();
                    break;
                case 'clearAllOutputs':
                    docManager?.clearAllOutputs();
                    break;
                // ---
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
                        
                        console.log(`[Provider] Deleting slide: ${slideIndex}`);
                        document.deleteCell(slideIndex);

                        const isMac = process.platform === 'darwin';
                        const shortcut = isMac ? 'Cmd+Z' : 'Ctrl+Z';

                        // This message has no button and will disappear on its own
                        vscode.window.showInformationMessage(`Slide ${slideIndex + 1} deleted. Use ${shortcut} to undo.`);    
                
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
                case 'requestKernelSelection': {
                    const docManager = this.documentManagers.get(document);
                    if (!docManager) {
                        // This is a safeguard for a case that should not happen.
                        vscode.window.showErrorMessage("Error: Document manager not found.");
                        break;
                    }

                    if (docManager.isStrategyInitialized()) {
                        const specs = docManager.getAvailableKernelSpecs();
                        const currentKernelName = docManager.getActiveKernelName();

                        const selectAnotherKernelItem: vscode.QuickPickItem = {
                            label: `$(notebook-kernel-select) Select Another Kernel...`,
                            detail: "Choose a different Python environment to start a new server",
                            alwaysShow: true
                        };

                        const uniqueKernelItems = new Map<string, KernelQuickPickItem>();

                        if (specs?.kernelspecs) {
                            for (const spec of Object.values(specs.kernelspecs)) {
                                const sp = spec?.spec as ISpecModel | undefined;
                                if (!sp) { continue; }

                                const pythonPath = sp.argv[0];
                                // If we've already added an entry for this python path, skip.
                                if (uniqueKernelItems.has(pythonPath)) { continue; }

                                // Prioritize our registered kernel's display name if available.
                                const isOurKernel = spec?.name.startsWith('ipynb-slideshow-');
                                if (uniqueKernelItems.has(pythonPath) && !isOurKernel) { continue; }

                                const displayName = sp.display_name || 'Unnamed Kernel';
                                uniqueKernelItems.set(pythonPath, {
                                    label: `$(notebook-kernel-icon) ${displayName}`,
                                    description: (spec?.name === currentKernelName) ? " (Currently Active)" : "",
                                    kernelName: spec!.name,
                                    pythonPath: sp?.argv[0] || ''
                                });
                            }
                        }

                        // Create the list of available kernels from the current server
                        const kernelItems: KernelQuickPickItem[] = Array.from(uniqueKernelItems.values());

                        // Show the Quick Pick menu with all options
                                                // Use await to make the code flow sequentially
                        const selected = await vscode.window.showQuickPick(
                            [...kernelItems, { label: '', kind: vscode.QuickPickItemKind.Separator }, selectAnotherKernelItem], 
                            { placeHolder: "Select a kernel to switch to or choose a new environment" }
                        );

                        if (!selected) {
                            console.log('[Provider] Kernel selection cancelled.');
                            break; // Exit the case if nothing was selected
                        }

                        // Case 1: The user selected the "Select Another Kernel..." option
                        if (selected.label === selectAnotherKernelItem.label) {
                            this.promptForEnvironmentAndRestart(document);

                        // Case 2: The user selected an existing kernel from the list
                        } else if ((selected as KernelQuickPickItem).kernelName) {
                            const selectedKernel = selected as KernelQuickPickItem;
                            if (selectedKernel.kernelName !== currentKernelName) {

                                // 1. Immediately tell the webview we are busy.
                                this.updateWebviewContent(document, webviewPanel, { kernelStatus: 'busy' });

                                // 2. Perform the actual switch in the background.
                                docManager.switchKernelSession(selectedKernel.kernelName).then(async () => {
                                    // 3. After it's done, save the new path.
                                    const pythonPathKey = `${PYTHON_PATH_KEY_PREFIX}${document.uri.toString()}`;
                                    await this.context.workspaceState.update(pythonPathKey, selectedKernel.pythonPath);
                                    
                                    // 4. Finally, send a complete update with the new kernel name and idle status.
                                    this.updateAllWebviewsForDocument(document);
                                }).catch(err => {
                                    vscode.window.showErrorMessage(`Failed to switch kernel: ${err.message}`);
                                    // If it fails, tell the UI to go back to idle.
                                    this.updateAllWebviewsForDocument(document);
                                });
                            }
                        
                        }

                    } else {
                        // The automatic bootstrap failed. We now immediately start the manual
                        // process of selecting a new environment to start a server with.
                        console.log('[Provider] Server not initialized. Starting manual kernel selection flow.');
         
                        // We combine both ideas: show "No Kernels Found" AND the option to select another.
                        const noKernelsItem: vscode.QuickPickItem = { label: "No Kernels Found", description: "Could not automatically start a Jupyter server." };
                        const selectAnotherKernelItem: vscode.QuickPickItem = {
                            label: `$(notebook-kernel-select) Select Another Kernel...`,
                            detail: "Choose a Python environment to configure a kernel"
                        };

                        const selection = await vscode.window.showQuickPick(
                            [noKernelsItem, { label: '', kind: vscode.QuickPickItemKind.Separator }, selectAnotherKernelItem],
                            { placeHolder: "No kernel is active. Select an environment to get started." }
                        );

                        if (selection?.label === selectAnotherKernelItem.label) {
                            // Here we call the new prompter function.
                            await this.promptForEnvironmentAndRestart(document);
                        }
                    }

                    break;
                }
                case 'togglePresentationMode': {
                    const docManager = this.documentManagers.get(document);
                    if (docManager) {
                        if (docManager.isInPresentationMode) {
                            await docManager.exitPresentationMode();
                        } else {
                            await docManager.enterPresentationMode();
                        }
                        this.updateAllWebviewsForDocument(document);
                    }
                    break;
                }
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

    private updateAllWebviewsForDocument(document: IpynbSlideDocument): void {
        const webviews = this.documentWebviews.get(document.uri.toString());
        webviews?.forEach(panel => this.updateWebviewContent(document, panel));
    }

    private updateWebviewContent(document: IpynbSlideDocument, webviewPanel: vscode.WebviewPanel, overridePayload?: Partial<SlidePayload>): void {
        const currentSlideData = document.getCurrentSlideData();
        const notebookMetadata = document.getNotebookMetadata();
        const notebookLanguage = (notebookMetadata?.language_info?.name || notebookMetadata?.kernelspec?.language || 'plaintext').toLowerCase();

        const manager = this.documentManagers.get(document);
        // Get the kernel name from the manager, or use a default if not running.
        const controllerName = manager?.getActiveKernelDisplayName() || 'Select Kernel';

        // Determine if the last execution was successful by checking for error outputs.
        // We assume success unless an error output is found.
        let executionSuccess = true; 
        if (currentSlideData?.outputs && currentSlideData.outputs.length > 0) {
            // If there's any output with the type 'error', we mark it as a failure.
            if (currentSlideData.outputs.some(output => output.output_type === 'error')) {
                executionSuccess = false;
            }
        }
        
        console.log(`[Provider] Updating webview. Sending controllerName: '${controllerName}'`);
        const hasAnyOutputs = document.cells.some(cell => 
            cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0
        );
    
        console.log(`[Provider] Sending slide ${document.currentSlideIndex} to webview for ${document.uri.fsPath}. Lang: ${notebookLanguage}`);
        webviewPanel.webview.postMessage({
            type: 'update',
            payload: {
                slideIndex: document.currentSlideIndex,
                totalSlides: document.cells.length,
                cell: currentSlideData,
                notebookLanguage: notebookLanguage,
                controllerName: controllerName,
                executionSuccess: executionSuccess,
                hasAnyOutputs: hasAnyOutputs,
                isInPresentationMode: manager?.isInPresentationMode,
                ...overridePayload
            }
        });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.css')); 
        const monacoStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.main.css')); // If using manual Monaco CSS copy
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon.css'));

        const isMac = process.platform === 'darwin';
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
                <link href="${codiconsUri}" rel="stylesheet" />
                <link href="${monacoStyleUri}" rel="stylesheet" data-name="vs/editor/editor.main" />
            </head>
            <body>
            <div id="custom-tooltip-wrapper"></div>
            <div id="shortcut-overlay">
                <ul>
                    <li><kbd>Cmd/Ctrl + B</kbd><span>Toggle Sidebar</span></li>
                    <li><kbd>Cmd/Ctrl + Enter</kbd><span>Run Cell</span></li>
                    <li><kbd>Esc</kbd><span>Exit Presentation Mode</span></li>
                    <li><kbd class="arrow-key">&lt;</kbd><span>Previous Slide</span></li>
                    <li><kbd class="arrow-key">&gt;</kbd><span>Next Slide</span></li>
                </ul>
            </div>
            <div id="toolbar-container">
                <div id="main-toolbar">
                    <div class="toolbar-actions-left">
                        <button id="undo-button" class="toolbar-button" data-tooltip="${isMac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'}">
                            <span class="codicon codicon-redo icon-flip"></span>
                        </button>
                        <button id="redo-button" class="toolbar-button" data-tooltip="${isMac ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)'}">
                            <span class="codicon codicon-redo"></span>
                        </button>
                        <button id="run-all-button" class="toolbar-button" data-tooltip="Run All Cells">
                            <span class="codicon codicon-run-all"></span>
                            <span>Run All</span>
                        </button>
                        <button id="restart-kernel-button" class="toolbar-button" data-tooltip="Restart Kernel">
                            <span class="codicon codicon-refresh"></span>
                            <span>Restart</span>
                        </button>
                        <button id="clear-outputs-button" class="toolbar-button" data-tooltip="Clear All Outputs">
                            <span class="codicon codicon-clear-all"></span>
                            <span>Clear All Outputs</span>
                        </button>
                    </div>
                    <div class="toolbar-group-center">
                        <button id="fullscreen-button" class="toolbar-button" data-tooltip="Presentation Mode">
                            <span class="codicon codicon-screen-full"></span>
                            <span>Present</span>
                        </button>
                    </div>
                    <div class="toolbar-actions-right">
                        <div id="kernel-status-container">
                            <span id="kernel-indicator-icon"></span>
                            <span id="kernel-indicator-name">Not Selected</span>
                        </div>
                    </div>
                </div>
            </div>
            <div id="main-view-wrapper">
                <div class="slide-positioning-context">
                    <div id="add-slide-left-container" class="side-add-slide-container">
                        <div class="insert-controls">
                            <div class="insert-line"></div>
                            <div class="insert-buttons">
                                <button id="add-code-before" class="insert-button">+ Code</button>
                                <button id="add-markdown-before" class="insert-button">+ Markdown</button>
                            </div>
                        </div>
                    </div>

                    <div id="slide-content">  
                        <p>Loading slide content...</p>
                    </div>

                    <div id="add-slide-right-container" class="side-add-slide-container">
                        <div class="insert-controls">
                            <div class="insert-line"></div>
                            <div class="insert-buttons">
                                <button id="add-code-after" class="insert-button">+ Code</button>
                                <button id="add-markdown-after" class="insert-button">+ Markdown</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div id="controls">
                <button id="prev-button" data-tooltip="Previous Slide (←)">
                    <span class="codicon codicon-chevron-left"></span>
                </button>
                <span id="slide-indicator"></span>
                <button id="next-button" data-tooltip="'Next Slide (→)'">
                    <span class="codicon codicon-chevron-right"></span>
                </button>
            </div>

            <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }
    /**
     * This method is called AFTER a Python environment has been selected or created.
     * It checks for ipykernel and then triggers the server restart.
     */
    private async handleEnvironmentSelection(document: IpynbSlideDocument, pythonPath: string | undefined) {
        if (!pythonPath) { return; }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Configuring environment: ${path.basename(pythonPath)}`,
            cancellable: true
        }, async (progress, token) => {
            try {
                // Step 1: Check for ipykernel
                progress.report({ message: "Checking for ipykernel package..." });
                const tempStrategy = new BackgroundNotebookProxyStrategy(document.uri, {}, undefined);
                const hasPackages = await tempStrategy.hasRequiredPackages(pythonPath);

                if (token.isCancellationRequested) { return; }

                // Step 2: Install if missing
                if (!hasPackages) {
                    progress.report({ message: "Installing 'ipykernel' package..." });
                    await tempStrategy.installPackages(pythonPath, ['ipykernel', 'jupyter_server']);
                }
                if (token.isCancellationRequested) { return; }

                // Step 3: Ensure the kernel is registered
                progress.report({ message: "Registering kernel with Jupyter..." });
                await tempStrategy.registerKernel(pythonPath);
                if (token.isCancellationRequested) { return; }

                // Step 4: Now, restart the server with the fully configured environment
                progress.report({ message: "Starting Jupyter server..." });
                
                const oldDocManager = this.documentManagers.get(document);
                if (oldDocManager) { await oldDocManager.dispose(); }

                const newStrategy = new BackgroundNotebookProxyStrategy(document.uri, document.getNotebookData(), pythonPath);
                const newDocManager = new DocumentManager(document, newStrategy);
                this.documentManagers.set(document, newDocManager);

                await newDocManager.initialize();
                this.updateAllWebviewsForDocument(document);
                vscode.window.showInformationMessage(`Successfully started server with ${newDocManager.getActiveKernelDisplayName()}`);

                // After everything succeeds, save the new path.
                const pythonPathKey = `${PYTHON_PATH_KEY_PREFIX}${document.uri.toString()}`;
                await this.context.workspaceState.update(pythonPathKey, pythonPath);
                console.log(`[Provider] Saved new Python path for document: ${pythonPath}`);
                
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to configure environment: ${e.message}`);
                console.error(`[Provider] Error during environment handling:`, e);
            }
        });
    }

    /**
     * This method handles the full user-facing flow for choosing a new environment.
     * It shows the "Select..." vs "Create..." menu and handles the result.
     */
    private async promptForEnvironmentAndRestart(document: IpynbSlideDocument) {
        const selectExistingEnvItem: vscode.QuickPickItem = {
            label: `$(notebook-kernel-select) Select Python Environment...`,
            detail: "Choose from a list of existing Python environments"
        };
        const createNewEnvItem: vscode.QuickPickItem = {
            label: `$(add) Create Python Environment...`,
            detail: "Create a new .venv or Conda environment"
        };

        const selection = await vscode.window.showQuickPick(
            [selectExistingEnvItem, createNewEnvItem],
            { placeHolder: "Select a source for your Jupyter Kernel" }
        );

        if (!selection) { return; }

        try {
            if (selection.label === createNewEnvItem.label) {
                // Call the create command and wait for it to finish.
                await vscode.commands.executeCommand('python.createEnvironment');
                
                // Simply inform the user and let them re-initiate the action.
                // This avoids race conditions with the Python extension's internal state.
                vscode.window.showInformationMessage(
                    'Environment created successfully. Please select "Select Another Kernel..." again to choose it.'
                );

            } else if (selection.label === selectExistingEnvItem.label) {
                await vscode.commands.executeCommand('python.setInterpreter');
                const newPath = await vscode.commands.executeCommand<string>('python.interpreterPath', document.uri);
                // After selecting, we can proceed with the robust handler.
                if (newPath) {
                    this.handleEnvironmentSelection(document, newPath);
                }
            }
        } catch (error: any) {
            console.error('[Provider] Error during environment prompt:', error);
            vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
        }
    }


    private async selectInterpreterPath(documentUri: vscode.Uri): Promise<string | undefined> {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('The Python extension (ms-python.python) is not installed.');
            return undefined;
        }
        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        await vscode.commands.executeCommand('python.setInterpreter');

        // Pass the documentUri argument here
        const pythonPath = await vscode.commands.executeCommand<string>('python.interpreterPath', documentUri);

        if (pythonPath) {
            console.log(`[Provider] User selected/confirmed Python interpreter at: ${pythonPath}`);
            return pythonPath;
        }
        
        console.log('[Provider] Interpreter selection was cancelled or no path was returned.');
        return undefined;
    }
}