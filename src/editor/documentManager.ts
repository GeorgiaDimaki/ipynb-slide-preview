import * as vscode from 'vscode';
import { IKernelExecutionStrategy } from './executionStrategy';
import { IpynbSlideDocument } from './ipynbSlideDocument'; // Import this
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';
import { ISpecModels } from '@jupyterlab/services/lib/kernelspec/restapi';

export class DocumentManager {
    private executionStrategy: IKernelExecutionStrategy;
    private _isBusy: boolean = false;
    private readonly _onBusyStateChanged = new vscode.EventEmitter<boolean>();
    public readonly onBusyStateChanged = this._onBusyStateChanged.event;
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



    constructor(
        private readonly document: IpynbSlideDocument,
        strategy: IKernelExecutionStrategy
    ) {
        this.executionStrategy = strategy;
    }

    public isBusy(): boolean {
        return this._isBusy;
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

    public async initialize(): Promise<void> {
        // Delegate initialization to the strategy
        await this.executionStrategy.initialize();
    }
    public enterPresentationMode(): void {
        if (this.isInPresentationMode) {return;}

        const workbenchConfig = vscode.workspace.getConfiguration('workbench');
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const breadcrumbsConfig = vscode.workspace.getConfiguration('breadcrumbs');

        // 1. Read and store the initial state of all settings
        this.initialSettings.activityBarLocation = workbenchConfig.get('activityBar.location', 'default'); // MODIFIED
        this.initialSettings.statusBarVisible = workbenchConfig.get('statusBar.visible', true);
        this.initialSettings.editorTabsVisible = workbenchConfig.get('editor.showTabs', true);
        this.initialSettings.editorActionsLocation = workbenchConfig.get('editor.editorActionsLocation', 'default');
        this.initialSettings.lineNumbers = editorConfig.get('lineNumbers', 'on');
        this.initialSettings.minimapEnabled = editorConfig.get('minimap.enabled', true);
        this.initialSettings.breadcrumbsEnabled = breadcrumbsConfig.get('enabled', true);

        // 2. Update settings to hide UI elements
        workbenchConfig.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global); // MODIFIED
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

    public async exitPresentationMode(): Promise<void> {
        if (!this.isInPresentationMode) {return;}

        const workbenchConfig = vscode.workspace.getConfiguration('workbench');
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const breadcrumbsConfig = vscode.workspace.getConfiguration('breadcrumbs');

        // 1. Restore all settings from our stored initial values
        await workbenchConfig.update('activityBar.location', this.initialSettings.activityBarLocation, vscode.ConfigurationTarget.Global); // MODIFIED
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

    public async runCell(index: number): Promise<void> {
        return this.performBusyAction(async () => {
            const cell = this.document.cells[index];
            if (!cell || cell.cell_type !== 'code') {return;}

            const startTime = performance.now();
            const newOutputs = await this.executionStrategy.executeCell(cell);
            const duration = ((performance.now() - startTime) / 1000).toFixed(2);
            const success = !newOutputs.some(o => o.output_type === 'error');
            
            this.document.updateCellExecutionResult(index, newOutputs, { success, duration: `${duration}s` });
        });
    }
    
    public async runAllCells(): Promise<void> {
        return this.performBusyAction(async () => {
            console.log('[DocumentManager] Starting Run All...');
            for (let i = 0; i < this.document.cells.length; i++) {
                if (this.document.cells[i].cell_type === 'code') {
                    const cell = this.document.cells[i];
                    const startTime = performance.now();
                    const newOutputs = await this.executionStrategy.executeCell(cell);
                    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
                    const success = !newOutputs.some(o => o.output_type === 'error');
                    
                    this.document.updateCellExecutionResult(i, newOutputs, { success, duration: `${duration}s` });

                    if (!success) {
                        vscode.window.showErrorMessage(`Execution failed at slide ${i + 1}. Halting Run All.`);
                        break;
                    }
                }
            }
        });
    }

    public clearAllOutputs(): void {
        // This action is synchronous, so it doesn't need the async wrapper, but it still must check the busy state.
        if (this._isBusy) {
            vscode.window.showInformationMessage("An operation is already in progress.");
            return;
        }
        this.document.clearAllOutputs();
        this.document.resetExecutionOrder();
    }

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

    public async dispose(): Promise<void> {
        // This is where we ensure cleanup happens if the editor is closed while presenting
        if (this.isInPresentationMode) {
            await this.exitPresentationMode();
        }
        await this.executionStrategy.dispose();
    }
    
    public isStrategyInitialized(): boolean {
        // We need to cast the strategy to our specific type to access the property
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).isInitialized;
    }

    public getActiveKernelName(): string | undefined {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getActiveKernelName();
    }

    public getActiveKernelDisplayName(): string | undefined {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getActiveKernelDisplayName();
    }

    public getAvailableKernelSpecs(): ISpecModels | null | undefined {
        // Return type is 'any' to avoid circular dependencies with services types
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).getAvailableKernelSpecs();
    }

    public async switchKernelSession(kernelName: string): Promise<void> {
        await (this.executionStrategy as BackgroundNotebookProxyStrategy).switchKernelSession(kernelName);
    }

    public get onKernelChanged(): vscode.Event<void> {
        return (this.executionStrategy as BackgroundNotebookProxyStrategy).onKernelChanged;
    }
}