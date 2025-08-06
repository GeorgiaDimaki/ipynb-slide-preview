import * as vscode from 'vscode';
import { IKernelExecutionStrategy } from './executionStrategy';
import { IpynbCell, IpynbSlideDocument, NotebookOutput } from './ipynbSlideDocument'; // Import this
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';
import { ISpecModels } from '@jupyterlab/services/lib/kernelspec/restapi';

/**
 * Orchestrates high-level operations for a single slide document,
 * managing its execution state and interaction with the Jupyter kernel.
 */
export class DocumentManager {
    private executionStrategy: IKernelExecutionStrategy;
    private _isBusy: boolean = false;
    private readonly _onBusyStateChanged = new vscode.EventEmitter<boolean>();

    /**
     * An event that fires when the manager's busy state changes.
     * True if an operation is in progress, false otherwise.
     */
    public readonly onBusyStateChanged = this._onBusyStateChanged.event;

    /**
     * Tracks whether the editor is currently in the distraction-free presentation mode.
     */
    public isInPresentationMode: boolean = false;

    private initialSettings = {
        activityBarLocation: 'default', 
        statusBarVisible: true,
        editorTabsVisible: true,
        editorActionsLocation: 'default',
        lineNumbers: 'on',
        minimapEnabled: true,
        breadcrumbsEnabled: true,
    };

    /**
     * Creates an instance of DocumentManager.
     * @param document The slide document this manager is responsible for.
     * @param strategy The kernel execution strategy to use for running code.
     */
    constructor(
        private readonly document: IpynbSlideDocument,
        strategy: IKernelExecutionStrategy
    ) {
        this.executionStrategy = strategy;
    }

    /**
     * Checks if the manager is currently performing a long-running operation.
     * @returns `true` if busy, `false` otherwise.
     */
    public isBusy(): boolean {
        return this._isBusy;
    }

    /**
     * Initializes the underlying kernel execution strategy,
     * which typically involves starting a Jupyter server and kernel session.
     */
    public async initialize(): Promise<void> {
        // Delegate initialization to the strategy
        await this.executionStrategy.initialize();
    }

    /**
     * Executes a single code cell by its index in the document.
     * @param index The zero-based index of the cell to run.
     */
    public async runCell(index: number): Promise<void> {
        return this.performBusyAction(async () => {
            const cell = this.document.cells[index];
            if (!cell || cell.cell_type !== 'code') {return;}
            const result = await this.__run(cell);
            this.document.updateCellExecutionResult(index, result.outputs, result.meta);
        });
    }
    
    /**
     * Executes all code cells in the document sequentially from top to bottom.
     * Halts execution if a cell produces an error.
     */
    public async runAllCells(): Promise<void> {
        return this.performBusyAction(async () => {
            console.log('[DocumentManager] Starting Run All...');
            for (let i = 0; i < this.document.cells.length; i++) {
                if (this.document.cells[i].cell_type === 'code') {
                    const result = await this.__run(this.document.cells[i]);
                    this.document.updateCellExecutionResult(i, result.outputs, result.meta);
                    if (!result.meta.success) {
                        vscode.window.showErrorMessage(`Execution failed at slide ${i + 1}. Halting Run All.`);
                        break;
                    }
                }
            }
        });
    }

    /**
     * Clears all outputs from all code cells in the document and resets the execution counter.
     */
    public clearAllOutputs(): void {
        // This action is synchronous, so it doesn't need the async wrapper, but it still must check the busy state.
        if (this._isBusy) {
            vscode.window.showInformationMessage("An operation is already in progress.");
            return;
        }
        this.document.clearAllOutputs();
        this.document.resetExecutionOrder();
    }

    /**
     * Restarts the current Jupyter kernel session.
     */
    public restartKernel(): Promise<void> {
        return this.performBusyAction(async () => {
            // We wrap the entire operation in vscode.window.withProgress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, // Show it as a pop-up notification
                title: "Restarting Jupyter Kernel", // The main title of the notification
                cancellable: false // The user cannot cancel this operation
            }, async (progress) => {
                
                // Restart the kernel via the strategy
                progress.report({ message: "Sending restart request to server..." });
                await (this.executionStrategy as BackgroundNotebookProxyStrategy).restartKernel();

                // A brief pause so the user can read the message before the next step
                await new Promise(resolve => setTimeout(resolve, 400));

                // The notification will automatically disappear when this function completes.
                this.document.resetExecutionOrder();
            });
        });
    }

    /**
     * Cleans up all resources used by the manager, including the underlying execution strategy.
     * This is typically called when the custom editor is closed.
     */
    public async dispose(): Promise<void> {
        // This is where we ensure cleanup happens if the editor is closed while presenting
        if (this.isInPresentationMode) {
            await this.exitPresentationMode();
        }
        await this.executionStrategy.dispose();
    }
    
    /**
     * Checks if the underlying execution strategy has been successfully initialized.
     * @returns `true` if the strategy is initialized, `false` otherwise.
     */
    public isStrategyInitialized(): boolean {
        // We need to cast the strategy to our specific type to access the property
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).isInitialized;
    }

    /**
     * Gets the internal name of the currently active kernel (e.g., 'python3').
     * @returns The kernel name string or undefined if no kernel is active.
     */
    public getActiveKernelName(): string | undefined {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getActiveKernelName();
    }

    /**
     * Gets the user-friendly display name of the currently active kernel (e.g., 'Python 3.10').
     * @returns The kernel display name string or undefined if no kernel is active.
     */
    public getActiveKernelDisplayName(): string | undefined {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getActiveKernelDisplayName();
    }

    /**
     * Retrieves the list of all available kernel specifications from the Jupyter server.
     * @returns The ISpecModels object or null/undefined if not available.
     */
    public getAvailableKernelSpecs(): ISpecModels | null | undefined {
        // Return type is 'any' to avoid circular dependencies with services types
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getAvailableKernelSpecs();
    }

    /**
     * Switches the active kernel for the current session to a new one.
     * @param kernelName The internal name of the new kernel to switch to.
     */
    public async switchKernelSession(kernelName: string): Promise<void> {
        await (this.executionStrategy as BackgroundNotebookProxyStrategy).switchKernelSession(kernelName);
    }

    /**
     * An event that fires when the underlying kernel connection changes.
     */
    public get onKernelChanged(): vscode.Event<void> {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).onKernelChanged;
    }

    /**
     * Enters a distraction-free presentation mode by changing global VS Code UI settings.
     */
    public enterPresentationMode(): void {
        if (this.isInPresentationMode) {return;}

        const workbenchConfig = vscode.workspace.getConfiguration('workbench');
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const breadcrumbsConfig = vscode.workspace.getConfiguration('breadcrumbs');

        // 1. Read and store the initial state of all settings
        this.initialSettings.activityBarLocation = workbenchConfig.get('activityBar.location', 'default');
        this.initialSettings.statusBarVisible = workbenchConfig.get('statusBar.visible', true);
        this.initialSettings.editorTabsVisible = workbenchConfig.get('editor.showTabs', true);
        this.initialSettings.editorActionsLocation = workbenchConfig.get('editor.editorActionsLocation', 'default');
        this.initialSettings.lineNumbers = editorConfig.get('lineNumbers', 'on');
        this.initialSettings.minimapEnabled = editorConfig.get('minimap.enabled', true);
        this.initialSettings.breadcrumbsEnabled = breadcrumbsConfig.get('enabled', true);

        // 2. Update settings to hide UI elements
        workbenchConfig.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global); 
        workbenchConfig.update('statusBar.visible', false, vscode.ConfigurationTarget.Global);
        workbenchConfig.update('editor.showTabs', false, vscode.ConfigurationTarget.Global);
        workbenchConfig.update('editor.editorActionsLocation', 'hidden', vscode.ConfigurationTarget.Global);
        editorConfig.update('lineNumbers', 'off', vscode.ConfigurationTarget.Global);
        editorConfig.update('minimap.enabled', false, vscode.ConfigurationTarget.Global);
        breadcrumbsConfig.update('enabled', false, vscode.ConfigurationTarget.Global);

        // 3. Hide the Side Bar and Panel using commands
        vscode.commands.executeCommand('workbench.action.closePanel');
        vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');

        this.isInPresentationMode = true;
    }

    /**
     * Exits the distraction-free presentation mode by restoring global VS Code UI settings to their previous state.
     */
    public async exitPresentationMode(): Promise<void> {
        if (!this.isInPresentationMode) {return;}

        const workbenchConfig = vscode.workspace.getConfiguration('workbench');
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const breadcrumbsConfig = vscode.workspace.getConfiguration('breadcrumbs');

        // 1. Restore all settings from our stored initial values
        await workbenchConfig.update('activityBar.location', this.initialSettings.activityBarLocation, vscode.ConfigurationTarget.Global);
        await workbenchConfig.update('statusBar.visible', this.initialSettings.statusBarVisible, vscode.ConfigurationTarget.Global);
        await workbenchConfig.update('editor.showTabs', this.initialSettings.editorTabsVisible, vscode.ConfigurationTarget.Global);
        await workbenchConfig.update('editor.editorActionsLocation', this.initialSettings.editorActionsLocation, vscode.ConfigurationTarget.Global);
        await editorConfig.update('lineNumbers', this.initialSettings.lineNumbers, vscode.ConfigurationTarget.Global);
        await editorConfig.update('minimap.enabled', this.initialSettings.minimapEnabled, vscode.ConfigurationTarget.Global);
        await breadcrumbsConfig.update('enabled', this.initialSettings.breadcrumbsEnabled, vscode.ConfigurationTarget.Global);

        // 2. Restore the Side Bar
        await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
        await vscode.commands.executeCommand('workbench.action.togglePanel');

        this.isInPresentationMode = false;
    }

    private async performBusyAction(action: () => Promise<any>) {
        if (this._isBusy) {
            vscode.window.showInformationMessage("An operation is already in progress.");
            return;
        }
        this._isBusy = true;
        this._onBusyStateChanged.fire(true);
        try {
            await action();
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message || 'An unexpected error occurred.');
            console.error('[DocumentManager] Action failed:', error);
        } finally {
            this._isBusy = false;
            this._onBusyStateChanged.fire(false);
        }
    }

    private async __run(cell: IpynbCell): Promise<{ outputs: NotebookOutput[], meta: { success: boolean, duration: string } }> {
        const startTime = performance.now();
        const newOutputs = await this.executionStrategy.executeCell(cell);
        const duration = ((performance.now() - startTime) / 1000).toFixed(2);
        const success = !newOutputs.some(o => o.output_type === 'error');
        return { outputs: newOutputs, meta: { success: success, duration: `${duration}s`} };
    }
}