import * as vscode from 'vscode';
import { IpynbCell, NotebookOutput } from './ipynbSlideDocument';
/**
 * Defines the contract for any class that can execute notebook cells.
 */
export interface IKernelExecutionStrategy extends vscode.Disposable {
    /**
     * Initializes the strategy.
     */
    initialize(): Promise<void>;

    /**
     * Executes a cell at a given index within a notebook document.
     * @param index The index of the cell to execute.
     */
    executeCell(cell: IpynbCell): Promise<NotebookOutput[]>;
}