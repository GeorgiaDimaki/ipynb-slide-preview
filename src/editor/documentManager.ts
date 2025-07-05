import { IKernelExecutionStrategy } from './executionStrategy';
import { IpynbSlideDocument } from './ipynbSlideDocument'; // Import this
import { BackgroundNotebookProxyStrategy } from './backgroundNotebookProxyStrategy';
import { ISpecModels } from '@jupyterlab/services/lib/kernelspec/restapi';
import * as vscode from 'vscode';

export class DocumentManager {
    private executionStrategy: IKernelExecutionStrategy;

    constructor(
        private readonly document: IpynbSlideDocument,
        strategy: IKernelExecutionStrategy
    ) {
        this.executionStrategy = strategy;
    }

    public async initialize(): Promise<void> {
        // Delegate initialization to the strategy
        await this.executionStrategy.initialize();
    }

    public async runCell(index: number): Promise<void> {
        const cell = this.document.cells[index];
        if (!cell || cell.cell_type !== 'code') return;
        
        // When we execute, we need to update the outputs.
        // The strategy will return the new outputs.
        const newOutputs = await this.executionStrategy.executeCell(cell);
        
        // We now call the method that updates the document and notifies the webview
        this.document.updateCellOutputs(index, newOutputs);
    }

    public dispose(): void {
        this.executionStrategy.dispose();
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