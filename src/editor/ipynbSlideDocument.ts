import * as vscode from 'vscode';

// --- Common Type Definitions for Notebook Structure ---
// (Ideally, these could be in a shared types.ts file if used by preview.ts too)

type Source = string | string[];

// Define specific output types based on nbformat
interface StreamOutput {
    output_type: 'stream';
    name: 'stdout' | 'stderr';
    text: Source;
}

interface DataBundle {
    [mimeType: string]: Source; // e.g., 'text/plain', 'text/html', 'image/png'
}

interface DisplayDataOutput {
    output_type: 'display_data';
    data: DataBundle;
    metadata?: Record<string, any>;
}

interface ExecuteResultOutput {
    output_type: 'execute_result';
    execution_count: number | null;
    data: DataBundle;
    metadata?: Record<string, any>;
}

interface ErrorOutput {
    output_type: 'error';
    ename: string; // Error name
    evalue: string; // Error value
    traceback: string[]; // Stack trace lines
}

// Union type for any possible output item
type NotebookOutput = StreamOutput | DisplayDataOutput | ExecuteResultOutput | ErrorOutput;

// Define the structure for a single cell
interface IpynbCell {
    cell_type: 'markdown' | 'code';
    source: Source;
    outputs?: NotebookOutput[]; // Use the detailed NotebookOutput type
    metadata: Record<string, any>;
}

// Define the structure for the entire parsed notebook
interface IpynbData {
    cells: IpynbCell[];
    metadata: Record<string, any>;
    nbformat: number;
    nbformat_minor: number;
}

// --- Document Implementation ---

export class IpynbSlideDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    private _documentData: IpynbData;
    private _currentSlideIndex: number = 0;

    private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
    public readonly onDidChangeContent = this._onDidChangeContent.event;

    private readonly _onDidChangeDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeDocument.event;

    private _contentChangeListener: vscode.Disposable | undefined;

    constructor(uri: vscode.Uri, initialContent: Uint8Array) {
        this.uri = uri;
        try {
            const jsonString = Buffer.from(initialContent).toString('utf8');
            const parsedData = JSON.parse(jsonString || '{}');

            // Basic validation and default structure
            this._documentData = {
                cells: Array.isArray(parsedData.cells) ? parsedData.cells : [],
                metadata: typeof parsedData.metadata === 'object' && parsedData.metadata !== null ? parsedData.metadata : {},
                nbformat: typeof parsedData.nbformat === 'number' ? parsedData.nbformat : 4,
                nbformat_minor: typeof parsedData.nbformat_minor === 'number' ? parsedData.nbformat_minor : 5,
            };

        } catch (e) {
            console.error(`[IpynbSlideDocument] Error parsing IPYNB file content for ${uri.fsPath}:`, e);
            this._documentData = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
        }
    }

    public setContentChangeListener(listener: vscode.Disposable): void {
        this._contentChangeListener = listener;
    }

    public dispose(): void {
        console.log(`[IpynbSlideDocument] Disposing document resources: ${this.uri.fsPath}`);
        this._contentChangeListener?.dispose();
        this._onDidChangeContent.dispose();
        this._onDidChangeDocument.dispose();
    }

    // --- Custom Properties and Methods ---

    get cells(): ReadonlyArray<IpynbCell> {
        return this._documentData.cells;
    }

    get currentSlideIndex(): number {
        return this._currentSlideIndex;
    }

    set currentSlideIndex(index: number) {
        const totalSlides = this.cells.length;
        const newIndex = Math.max(0, Math.min(index, totalSlides > 0 ? totalSlides - 1 : 0));

        if (newIndex !== this._currentSlideIndex || (totalSlides === 0 && this._currentSlideIndex !== 0)) {
            this._currentSlideIndex = newIndex;
            this._onDidChangeContent.fire();
            // TODO: Consider if changing slide index should be an "edit" for undo/redo.
        }
    }

    public getCurrentSlideData(): IpynbCell | undefined {
        if (this.cells.length === 0) {
            return undefined;
        }
        return this.cells[this.currentSlideIndex];
    }

    public getNotebookMetadata(): Record<string, any> {
        return this._documentData.metadata;
    }

    // --- Document Editing Methods ---

    public addCellBefore(currentIndex: number, cellType: 'markdown' | 'code'): void {
        this.insertCellAtIndex(currentIndex, cellType, 'Add Cell Before');
        // After insertion, the new cell is at 'currentIndex'.
        // We want to navigate to this newly added cell.
        this.currentSlideIndex = currentIndex; // Setter handles event firing if index changed
        this._onDidChangeContent.fire(); // Ensure UI updates even if index value was already target
    }

    public addCellAfter(currentIndex: number, cellType: 'markdown' | 'code'): void {
        const insertAtIndex = currentIndex + 1;
        this.insertCellAtIndex(insertAtIndex, cellType, 'Add Cell After');
        // After insertion, the new cell is at 'insertAtIndex'.
        // We want to navigate to this newly added cell.
        this.currentSlideIndex = insertAtIndex; // Setter handles event firing if index changed
        this._onDidChangeContent.fire(); // Ensure UI updates
    }

    private insertCellAtIndex(index: number, cellType: 'markdown' | 'code', undoLabel: string): void {
        if (index < 0 || index > this.cells.length) { // Allow inserting at the very end (index === cells.length)
            console.warn(`[IpynbSlideDocument] insertCellAtIndex: Invalid index ${index}. Total cells: ${this.cells.length}`);
            return;
        }

        const newCellSource = cellType === 'code' ? ['# New Code Cell'] : ['# New Markdown Slide'];
        const newCell: IpynbCell = {
            cell_type: cellType,
            source: newCellSource,
            metadata: {},
            outputs: cellType === 'code' ? [] : undefined, // Outputs only for code cells
        };

        const oldDocumentDataForUndo = JSON.parse(JSON.stringify(this._documentData));
        const oldSlideIndexForUndo = this._currentSlideIndex;

        this._documentData.cells.splice(index, 0, newCell);
        console.log(`[IpynbSlideDocument] Inserted ${cellType} cell at index ${index}. New count: ${this.cells.length}.`);

        this._onDidChangeDocument.fire({
            document: this,
            label: undoLabel,
            undo: async () => {
                this._documentData = oldDocumentDataForUndo;
                // Restore currentSlideIndex carefully, ensuring it's valid
                const maxRestoredIndex = this._documentData.cells.length > 0 ? this._documentData.cells.length - 1 : 0;
                this._currentSlideIndex = Math.min(oldSlideIndexForUndo, maxRestoredIndex);
                this._currentSlideIndex = Math.max(0, this._currentSlideIndex);
                this._onDidChangeContent.fire(); // Update webview
            },
            redo: async () => {
                this._documentData.cells.splice(index, 0, newCell);
                // When redoing, set current index to the newly added cell
                this.currentSlideIndex = index; // Go to the newly added (redone) cell
                this._onDidChangeContent.fire(); // Update webview
            }
        });
        // Note: _onDidChangeContent is fired by currentSlideIndex setter if it changes,
        // or explicitly after these operations to ensure webview syncs with cell list changes.
    }

    public runCell(index: number): void {
        if (index < 0 || index >= this.cells.length) {
            console.warn(`[IpynbSlideDocument] runCell: Invalid index ${index}. Total cells: ${this.cells.length}`);
            return;
        }

        const cell = this._documentData.cells[index];
        if (cell.cell_type === 'code') {
            const sourceCode = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
            console.log(`[IpynbSlideDocument] Request to run cell ${index}:`, sourceCode.substring(0, 100) + (sourceCode.length > 100 ? "..." : ""));

            // TODO: Implement actual code execution logic with VS Code Kernel APIs.
            const dummyOutput: StreamOutput = { // Correctly typed as StreamOutput
                output_type: 'stream',
                name: 'stdout',
                text: [`[Simulated output for cell ${index + 1} at ${new Date().toLocaleTimeString()}]`]
            };

            if (!cell.outputs) {
                cell.outputs = [];
            }
            cell.outputs.push(dummyOutput);

            this._onDidChangeContent.fire();
        } else {
            console.log(`[IpynbSlideDocument] runCell: Cell ${index} is a ${cell.cell_type} cell, not a code cell.`);
        }
    }

    public deleteCell(index: number): void {
        if (index < 0 || index >= this.cells.length) {
            console.warn(`[IpynbSlideDocument] deleteCell: Invalid index ${index}. Total cells: ${this.cells.length}`);
            return;
        }

        const oldDocumentData = JSON.parse(JSON.stringify(this._documentData));
        const oldSlideIndex = this._currentSlideIndex;

        const deletedCell = this._documentData.cells.splice(index, 1)[0];
        const deletedCellSourcePreview = Array.isArray(deletedCell.source)
            ? deletedCell.source.join('').substring(0, 30)
            : String(deletedCell.source).substring(0, 30);

        console.log(`[IpynbSlideDocument] Deleted cell at index ${index}. New cell count: ${this.cells.length}`);

        // Adjust currentSlideIndex after deletion
        let newCurrentIndex = oldSlideIndex;
        if (this.cells.length === 0) {
            newCurrentIndex = 0;
        } else if (oldSlideIndex === index) {
            newCurrentIndex = Math.min(index, this.cells.length - 1);
        } else if (oldSlideIndex > index) {
            newCurrentIndex = oldSlideIndex - 1;
        }
        // Use the setter to apply the new index and fire events if it changed
        this.currentSlideIndex = newCurrentIndex;

        // Always fire _onDidChangeContent after a delete, as totalSlides changed or content at current index changed
        // (even if currentSlideIndex itself didn't need to change value, its meaning might have)
        this._onDidChangeContent.fire();


        this._onDidChangeDocument.fire({
            document: this,
            label: `Delete Cell: "${deletedCellSourcePreview}..."`,
            undo: async () => {
                this._documentData = oldDocumentData;
                const maxRestoredIndex = this._documentData.cells.length > 0 ? this._documentData.cells.length - 1 : 0;
                this.currentSlideIndex = Math.min(oldSlideIndex, maxRestoredIndex);
                this.currentSlideIndex = Math.max(0, this.currentSlideIndex);
                this._onDidChangeContent.fire();
            },
            redo: async () => {
                this._documentData.cells.splice(index, 1);
                let redoCurrentIndex = oldSlideIndex;
                if (this.cells.length === 0) {
                    redoCurrentIndex = 0;
                } else if (oldSlideIndex === index) {
                    redoCurrentIndex = Math.min(index, this.cells.length - 1);
                } else if (oldSlideIndex > index) {
                    redoCurrentIndex = oldSlideIndex - 1;
                }
                this.currentSlideIndex = redoCurrentIndex;
                this._onDidChangeContent.fire();
            }
        });
        console.log(`[IpynbSlideDocument] After delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
    }

    // --- Methods Required by CustomEditorProvider (Stubs for a Read-Only/Preview Focus) ---

    async save(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log('[IpynbSlideDocument] Save operation invoked but not fully implemented for preview.');
        // Example: await this.saveAs(this.uri, _cancellation);
    }

    async saveAs(destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Save As operation invoked for ${destination.fsPath} but not fully implemented.`);
        // const fileData = Buffer.from(JSON.stringify(this._documentData, null, 2), 'utf8');
        // await vscode.workspace.fs.writeFile(destination, fileData);
    }

    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log('[IpynbSlideDocument] Revert operation invoked but not fully implemented.');
        // try {
        //     const fileData = await vscode.workspace.fs.readFile(this.uri);
        //     const jsonString = Buffer.from(fileData).toString('utf8');
        //     const parsedData = JSON.parse(jsonString || '{}');
        //     this._documentData = {
        //         cells: Array.isArray(parsedData.cells) ? parsedData.cells : [],
        //         metadata: typeof parsedData.metadata === 'object' && parsedData.metadata !== null ? parsedData.metadata : {},
        //         nbformat: typeof parsedData.nbformat === 'number' ? parsedData.nbformat : 4,
        //         nbformat_minor: typeof parsedData.nbformat_minor === 'number' ? parsedData.nbformat_minor : 5,
        //     };
        //     this.currentSlideIndex = 0; // Reset slide index, will fire _onDidChangeContent via setter
        //     this._onDidChangeContent.fire(); // Ensure webview updates if index didn't change but content did
        // } catch (e) {
        //     console.error(`[IpynbSlideDocument] Error reverting document ${this.uri.fsPath}:`, e);
        //     vscode.window.showErrorMessage(`Error reverting document: ${(e as Error).message}`);
        // }
    }

    async backup(destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        console.log(`[IpynbSlideDocument] Backup operation invoked for ${destination.fsPath}.`);
        try {
            const fileData = Buffer.from(JSON.stringify(this._documentData, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(destination, fileData);
        } catch (error) {
            console.error('[IpynbSlideDocument] Backup failed:', error);
            throw error;
        }
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                } catch {
                    // Ignored
                }
            }
        };
    }
}