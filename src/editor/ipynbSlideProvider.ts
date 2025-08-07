import * as vscode from 'vscode';
import { IpynbSlideDocument } from './ipynbSlideDocument';
import { getNonce } from './util';
import { DocumentManager } from './documentManager';
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';
import { ISpecModel } from '@jupyterlab/services/lib/kernelspec/restapi';
import { SlidePayload } from '../webviews/types';
import * as path from 'path';
import * as os from 'os';


const WORKSPACE_STATE_PREFIX = 'ipynbSlidePreview.currentSlideIndex:';
const PYTHON_PATH_KEY_PREFIX = 'ipynbSlidePreview.pythonPath:';

interface KernelQuickPickItem extends vscode.QuickPickItem {
    kernelName: string; // The internal kernel name, e.g., 'python3'
    pythonPath: string;
}

/**
 * The main controller for the IPYNB Slide Preview custom editor.
 * This class implements the `vscode.CustomEditorProvider` interface and is responsible for:
 * - Creating and managing the lifecycle of `IpynbSlideDocument` instances.
 * - Creating, managing, and providing content for the editor's webview panel.
 * - Handling all communication between the webview and the extension host.
 */
export class IpynbSlideProvider implements vscode.CustomEditorProvider<IpynbSlideDocument> {

    /**
     * An event that fires when an undoable/redoable edit is made from within a custom editor.
     */
    public readonly onDidChangeCustomDocument: vscode.Event<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>;

    // --- Private Properties ---
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>();
    private readonly documentEditListeners = new Map<string, vscode.Disposable>();
    private readonly documentWebviews = new Map<string, Set<vscode.WebviewPanel>>();
    private readonly documentManagers = new WeakMap<IpynbSlideDocument, DocumentManager>();


    private constructor(private readonly context: vscode.ExtensionContext) {
        this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
    }

    /**
     * Registers the custom editor provider and returns a disposable.
     * @param context The extension context.
     * @returns A disposable that unregisters the provider when disposed.
     */
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

    // =================================================================
    // Core CustomEditorProvider Implementation
    // =================================================================

    /**
     * Called when a custom editor is opened. This method creates the in-memory
     * document representation (`IpynbSlideDocument`) for the `.ipynb` file.
     * @param uri The URI of the document to open.
     * @param openContext Additional context about the opening, like backup IDs.
     * @returns A promise that resolves to the new `IpynbSlideDocument`.
     */
    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<IpynbSlideDocument> {
        console.log(`[Provider] Opening document: ${uri.fsPath}`);
        const backupUri = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
        const fileData: Uint8Array = await vscode.workspace.fs.readFile(backupUri);
        const document = new IpynbSlideDocument(uri, fileData);

        const pythonPathKey = `${PYTHON_PATH_KEY_PREFIX}${document.uri.toString()}`;
        const savedPythonPath = this.context.workspaceState.get<string>(pythonPathKey);
        console.log(`[Provider] Found saved Python path for this document: ${savedPythonPath}`);

        const strategy = new BackgroundNotebookProxyStrategy(document.uri, document.getNotebookData(), savedPythonPath);
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
            this._updateAllWebviewsForDocument(document);
        });

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
            this._updateAllWebviewsForDocument(document);
            const newWorkspaceStateKey = `${WORKSPACE_STATE_PREFIX}${document.uri.toString()}`;
            console.log(`[Provider] Saving slide index ${document.currentSlideIndex} to workspaceState for ${newWorkspaceStateKey}`);
            this.context.workspaceState.update(newWorkspaceStateKey, document.currentSlideIndex);
        });
        document.setContentChangeListener(changeListener);

        this.documentEditListeners.get(document.uri.toString())?.dispose();

        const editListener = document.onDidChangeCustomDocument(event => {
            // When the document fires its edit event, the provider relays it.
            console.log(`[Provider] Relaying onDidChangeCustomDocument event from document ${event.document.uri.fsPath}. Label: ${event.label}`);
            this._onDidChangeCustomDocument.fire(event);
        });
        this.documentEditListeners.set(document.uri.toString(), editListener);
        
        return document;
    }

    /**
     * Called when the visual editor (webview) needs to be created for a given document.
     * This method sets up the webview's HTML, options, and message listeners.
     * @param document The `IpynbSlideDocument` to render.
     * @param webviewPanel The webview panel to configure.
     */
    public async resolveCustomEditor(
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
            ]
        };

        webviewPanel.webview.html = this._getHtmlForWebview(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            console.log(`[Provider] Message received from webview: ${message.type}`, message.payload ?? '');
            const docManager = this.documentManagers.get(document);
            switch (message.type) {
                case 'ready':
                    this._updateWebviewContent(document, webviewPanel);
                    break;
                case 'previous':
                    document.currentSlideIndex--;
                    break;
                case 'next':
                    document.currentSlideIndex++;
                    break;
                case 'runCell':
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
                case 'deleteCell':
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        document.deleteCell(message.payload.slideIndex);
                    }
                    break;
                case 'requestDeleteConfirmation':
                    if (message.payload && typeof message.payload.slideIndex === 'number') {
                        const slideIndex = message.payload.slideIndex;
                        document.deleteCell(slideIndex);
                        const isMac = process.platform === 'darwin';
                        const shortcut = isMac ? 'Cmd+Z' : 'Ctrl+Z';
                        vscode.window.showInformationMessage(`Slide ${slideIndex + 1} deleted. Use ${shortcut} to undo.`);
                    }
                    break;
                case 'addCellBefore':
                    if (message.payload && typeof message.payload.currentSlideIndex === 'number' && (message.payload.cellType === 'markdown' || message.payload.cellType === 'code')) {
                        document.addCellBefore(message.payload.currentSlideIndex, message.payload.cellType);
                    }
                    break;
                case 'addCellAfter':
                    if (message.payload && typeof message.payload.currentSlideIndex === 'number' && (message.payload.cellType === 'markdown' || message.payload.cellType === 'code')) {
                        document.addCellAfter(message.payload.currentSlideIndex, message.payload.cellType);
                    }
                    break;
                case 'cellContentChanged':
                    if (message.payload && typeof message.payload.slideIndex === 'number' && typeof message.payload.newSource === 'string') {
                        document.updateCellSource(message.payload.slideIndex, message.payload.newSource);
                    }
                    break;
                case 'requestGlobalUndo':
                    vscode.commands.executeCommand('undo');
                    break;
                case 'requestGlobalRedo':
                    vscode.commands.executeCommand('redo');
                    break;
                case 'requestKernelSelection': {
                    const docManager = this.documentManagers.get(document);
                    if (!docManager) {
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
                                if (uniqueKernelItems.has(pythonPath)) { continue; }
                                const isOurKernel = spec?.name.startsWith('ipynb-slideshow-');
                                if (uniqueKernelItems.has(pythonPath) && !isOurKernel) { continue; }
                                const homeDir = os.homedir();
                                
                                const isActive = spec?.name === currentKernelName;
                                const activeText = isActive ? " (Currently Active)" : "";
                                // Format the path to use ~ for the home directory, like VS Code does
                                const displayPath = pythonPath.startsWith(homeDir) 
                                    ? `~${pythonPath.substring(homeDir.length)}` 
                                    : pythonPath;

                                const displayName = sp.display_name || 'Unnamed Kernel';
                                uniqueKernelItems.set(pythonPath, {
                                    label: `$(notebook-kernel-icon) ${displayName}`,
                                    description: `${displayPath}${activeText}`, // Use description for the path on the right
                                    kernelName: spec!.name,
                                    pythonPath: sp?.argv[0] || ''
                                });
                            }
                        }

                        const kernelItems: KernelQuickPickItem[] = Array.from(uniqueKernelItems.values());
                        const selected = await vscode.window.showQuickPick(
                            [...kernelItems, { label: '', kind: vscode.QuickPickItemKind.Separator }, selectAnotherKernelItem], 
                            { placeHolder: "Select a kernel to switch to or choose a new environment" }
                        );

                        if (!selected) {break;}

                        if (selected.label === selectAnotherKernelItem.label) {
                            this._promptForEnvironmentAndRestart(document);
                        } else if ((selected as KernelQuickPickItem).kernelName) {
                            const selectedKernel = selected as KernelQuickPickItem;
                            if (selectedKernel.kernelName !== currentKernelName) {
                                this._updateWebviewContent(document, webviewPanel, { kernelStatus: 'busy' });
                                docManager.switchKernelSession(selectedKernel.kernelName).then(async () => {
                                    const pythonPathKey = `${PYTHON_PATH_KEY_PREFIX}${document.uri.toString()}`;
                                    await this.context.workspaceState.update(pythonPathKey, selectedKernel.pythonPath);
                                    this._updateAllWebviewsForDocument(document);
                                }).catch(err => {
                                    vscode.window.showErrorMessage(`Failed to switch kernel: ${err.message}`);
                                    this._updateAllWebviewsForDocument(document);
                                });
                            }
                        }
                    } else {
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
                            await this._promptForEnvironmentAndRestart(document);
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
                        this._updateAllWebviewsForDocument(document);
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
                    documentManager.dispose();
                    this.documentManagers.delete(document);
                }
                this.documentEditListeners.get(uriString)?.dispose();
                this.documentEditListeners.delete(uriString);
            }
        });
    }

    // =================================================================
    // CustomEditorProvider File Operations
    // =================================================================

    /**
     * Saves the custom document.
     * @param document The document to save.
     * @param cancellation A cancellation token.
     */
    public async saveCustomDocument(document: IpynbSlideDocument, cancellation: vscode.CancellationToken): Promise<void> {
        await document.save(cancellation);
    }

    /**
     * Saves the custom document to a new location.
     * @param document The document to save.
     * @param destination The new file URI.
     * @param cancellation A cancellation token.
     */
    public async saveCustomDocumentAs(document: IpynbSlideDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        await document.saveAs(destination, cancellation);
    }

    /**
     * Reverts the custom document to its last saved state on disk.
     * @param document The document to revert.
     * @param cancellation A cancellation token.
     */
    public async revertCustomDocument(document: IpynbSlideDocument, cancellation: vscode.CancellationToken): Promise<void> {
        await document.revert(cancellation);
    }

    /**
     * Backs up the custom document's unsaved changes.
     * @param document The document to back up.
     * @param context Backup context information.
     * @param cancellation A cancellation token.
     */
    public async backupCustomDocument(document: IpynbSlideDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return await document.backup(context.destination, cancellation);
    }

    // =================================================================
    // Private Methods
    // =================================================================

    /**
     * Updates all active webviews for a given document with the latest content.
     * @param document The document whose webviews should be updated.
     */
    private _updateAllWebviewsForDocument(document: IpynbSlideDocument): void {
        const webviews = this.documentWebviews.get(document.uri.toString());
        webviews?.forEach(panel => this._updateWebviewContent(document, panel));
    }

    /**
     * Posts an 'update' message to a specific webview panel with the latest slide data.
     * @param document The document to get data from.
     * @param webviewPanel The webview panel to send the message to.
     * @param overridePayload Optional data to merge into the payload, like kernel status.
     */
    private _updateWebviewContent(document: IpynbSlideDocument, webviewPanel: vscode.WebviewPanel, overridePayload?: Partial<SlidePayload>): void {
        const currentSlideData = document.getCurrentSlideData();
        const notebookMetadata = document.getNotebookMetadata();
        const notebookLanguage = (notebookMetadata?.language_info?.name || notebookMetadata?.kernelspec?.language || 'plaintext').toLowerCase();

        const manager = this.documentManagers.get(document);
        const controllerName = manager?.getActiveKernelDisplayName() || 'Select Kernel';

        let executionSuccess = true; 
        if (currentSlideData?.outputs && currentSlideData.outputs.length > 0) {
            if (currentSlideData.outputs.some(output => output.output_type === 'error')) {
                executionSuccess = false;
            }
        }
        
        const hasAnyOutputs = document.cells.some(cell => 
            cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0
        );
    
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

    /**
     * Generates the complete HTML content for the webview.
     * @param webview The webview instance to generate HTML for.
     * @returns The HTML string.
     */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.bundle.css')); 
        const monacoStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.main.css'));
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
                        <button id="undo-button" class="toolbar-button" data-tooltip="${isMac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'}"><span class="codicon codicon-redo icon-flip"></span></button>
                        <button id="redo-button" class="toolbar-button" data-tooltip="${isMac ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)'}"><span class="codicon codicon-redo"></span></button>
                        <button id="run-all-button" class="toolbar-button" data-tooltip="Run All Cells"><span class="codicon codicon-run-all"></span><span>Run All</span></button>
                        <button id="restart-kernel-button" class="toolbar-button" data-tooltip="Restart Kernel"><span class="codicon codicon-refresh"></span><span>Restart</span></button>
                        <button id="clear-outputs-button" class="toolbar-button" data-tooltip="Clear All Outputs"><span class="codicon codicon-clear-all"></span><span>Clear All Outputs</span></button>
                    </div>
                    <div class="toolbar-spacer"></div>
                    <div class="toolbar-actions-right">
                        <button id="fullscreen-button" class="toolbar-button" data-tooltip="Presentation Mode"><span class="codicon codicon-screen-full"></span><span>Present</span></button>
                        <div id="kernel-status-container"><span id="kernel-indicator-icon"></span><span id="kernel-indicator-name">Not Selected</span></div>
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
                    <div id="slide-content"><p>Loading slide content...</p></div>
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
                <button id="prev-button" data-tooltip="Previous Slide (←)"><span class="codicon codicon-chevron-left"></span></button>
                <span id="slide-indicator"></span>
                <button id="next-button" data-tooltip="'Next Slide (→)'"><span class="codicon codicon-chevron-right"></span></button>
            </div>
            <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    /**
     * Guides the user through selecting or creating a Python environment and then
     * re-initializes the Jupyter server with the selected environment.
     * @param document The document for which to restart the kernel.
     */
    private async _promptForEnvironmentAndRestart(document: IpynbSlideDocument) {
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
                await vscode.commands.executeCommand('python.createEnvironment');
                vscode.window.showInformationMessage(
                    'Environment created. Please click "Select Another Kernel..." again to choose it.'
                );

            } else if (selection.label === selectExistingEnvItem.label) {
                await vscode.commands.executeCommand('python.setInterpreter');
                const newPath = await vscode.commands.executeCommand<string>('python.interpreterPath', document.uri);
                if (newPath) {
                    this._handleEnvironmentSelection(document, newPath);
                }
            }
        } catch (error: any) {
            console.error('[Provider] Error during environment prompt:', error);
            vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
        }
    }

    /**
     * Handles the post-selection logic for a Python environment, including package
     * installation, kernel registration, and server restart.
     * @param document The document associated with the action.
     * @param pythonPath The path to the selected Python interpreter.
     */
    private async _handleEnvironmentSelection(document: IpynbSlideDocument, pythonPath: string | undefined) {
        if (!pythonPath) { return; }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Configuring environment: ${path.basename(pythonPath)}`,
            cancellable: true
        }, async (progress, token) => {
            try {
                // Step 1: Check for ipykernel
                progress.report({ message: "Checking for required packages..." });
                const tempStrategy = new BackgroundNotebookProxyStrategy(document.uri, {}, undefined);
                const hasPackages = await tempStrategy.hasRequiredPackages(pythonPath);
                if (token.isCancellationRequested) { return; }

                // Step 2: Install if missing
                if (!hasPackages) {
                    progress.report({ message: "Installing 'ipykernel' and 'jupyter_server'..." });
                    await tempStrategy.installPackages(pythonPath, ['ipykernel', 'jupyter_server']);
                }
                if (token.isCancellationRequested) { return; }

                // Step 3: Ensure the kernel is registered
                progress.report({ message: "Registering kernel with Jupyter..." });
                await tempStrategy.registerKernel(pythonPath);
                if (token.isCancellationRequested) { return; }

                // Step 4: Now, restart the server with the fully configured environment
                progress.report({ message: "Restarting Jupyter server..." });
                const oldDocManager = this.documentManagers.get(document);
                if (oldDocManager) { await oldDocManager.dispose(); }

                const newStrategy = new BackgroundNotebookProxyStrategy(document.uri, document.getNotebookData(), pythonPath);
                const newDocManager = new DocumentManager(document, newStrategy);
                this.documentManagers.set(document, newDocManager);

                await newDocManager.initialize();
                this._updateAllWebviewsForDocument(document);
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
}