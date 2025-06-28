import { IKernelExecutionStrategy } from './executionStrategy';
import { IpynbSlideDocument } from './ipynbSlideDocument'; // Import this

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
}