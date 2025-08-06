import * as vscode from 'vscode';

// --- Common Type Definitions for Notebook Structure ---
// (Ideally, these could be in a shared types.ts file if used by preview.ts too)

type Source = string | string[];

// Define specific output types based on nbformat
export interface StreamOutput {
    output_type: 'stream';
    name: 'stdout' | 'stderr';
    text: Source;
}

interface DataBundle {
    [mimeType: string]: Source; // e.g., 'text/plain', 'text/html', 'image/png'
}

export interface DisplayDataOutput {
    output_type: 'display_data';
    data: DataBundle;
    metadata?: Record<string, any>;
}

export interface ExecuteResultOutput {
    output_type: 'execute_result';
    execution_count: number | null;
    data: DataBundle;
    metadata?: Record<string, any>;
}

export interface ErrorOutput {
    output_type: 'error';
    ename: string; // Error name
    evalue: string; // Error value
    traceback: string[]; // Stack trace lines
}

// Union type for any possible output item
export type NotebookOutput = StreamOutput | DisplayDataOutput | ExecuteResultOutput | ErrorOutput;

// Define the structure for a single cell
export interface IpynbCell {
    cell_type: 'markdown' | 'code';
    source: Source;
    outputs?: NotebookOutput[]; // Use the detailed NotebookOutput type
    metadata: Record<string, any>;
    execution_count?: number | null;
}

// Define the structure for the entire parsed notebook
export interface IpynbData {
    cells: IpynbCell[];
    metadata: Record<string, any>;
    nbformat: number;
    nbformat_minor: number;
}

// --- Document Implementation ---

/**
 * Represents the in-memory model of an .ipynb file, handling its content,
 * state, and providing methods for manipulation that integrate with VS Code's
 * custom editor and undo/redo systems.
 */
export class IpynbSlideDocument implements vscode.CustomDocument {
    /**
     * The file system URI of the document.
     */
    readonly uri: vscode.Uri;

    /**
     * An event that fires when the document's content changes in a way that requires a webview update.
     */
    public readonly onDidChangeContent: vscode.Event<void>;

    /**
     * An event that fires when an undoable/redoable edit is made to the document.
     */
    public readonly onDidChangeCustomDocument: vscode.Event<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>;

    // --- Private Properties ---
    private _documentData: IpynbData;
    private _currentSlideIndex: number = 0;
    private _executionOrder: number = 0;
    private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
    private readonly _onDidChangeDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IpynbSlideDocument>>();
    private _contentChangeListener: vscode.Disposable | undefined;


    constructor(uri: vscode.Uri, initialContent: Uint8Array) {
        this.uri = uri;
        this.onDidChangeContent = this._onDidChangeContent.event;
        this.onDidChangeCustomDocument = this._onDidChangeDocument.event;

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

    // =================================================================
    // Lifecycle & State
    // =================================================================

    /**
     * A readonly array of all cells in the notebook.
     */
    get cells(): ReadonlyArray<IpynbCell> {
        return this._documentData.cells;
    }

    /**
     * The index of the currently visible slide.
     */
    get currentSlideIndex(): number {
        return this._currentSlideIndex;
    }

    /**
     * Sets the current slide index, clamping it to valid bounds and firing a content change event.
     */
    set currentSlideIndex(index: number) {
        const totalSlides = this.cells.length;
        const newIndex = Math.max(0, Math.min(index, totalSlides > 0 ? totalSlides - 1 : 0));

        if (newIndex !== this._currentSlideIndex || (totalSlides === 0 && this._currentSlideIndex !== 0)) {
            this._currentSlideIndex = newIndex;
            this._onDidChangeContent.fire();
            // TODO: Consider if changing slide index should be an "edit" for undo/redo.
        }
    }

    /**
     * Disposes of all resources used by the document, primarily event emitters.
     */
    public dispose(): void {
        console.log(`[IpynbSlideDocument] Disposing document resources: ${this.uri.fsPath}`);
        this._contentChangeListener?.dispose();
        this._onDidChangeContent.dispose();
        this._onDidChangeDocument.dispose();
    }

    /**
     * Attaches a listener for when the document's content changes.
     * @param listener The disposable listener to attach.
     */
    public setContentChangeListener(listener: vscode.Disposable): void {
        this._contentChangeListener = listener;
    }

    // =================================================================
    // Data Accessors
    // =================================================================

    /**
     * Gets the entire notebook data structure.
     * @returns The raw IpynbData object.
     */
    public getNotebookData(): IpynbData {
        return this._documentData;
    }

    /**
     * Gets the cell data for the currently active slide.
     * @returns The cell data or undefined if there are no cells.
     */
    public getCurrentSlideData(): IpynbCell | undefined {
        if (this.cells.length === 0) {
            return undefined;
        }
        return this.cells[this.currentSlideIndex];
    }

    /**
     * Gets the notebook's top-level metadata.
     * @returns The metadata object.
     */
    public getNotebookMetadata(): Record<string, any> {
        return this._documentData.metadata;
    }

    // =================================================================
    // Document Editing
    // =================================================================

    /**
     * Inserts a new cell before the specified index and navigates to it.
     * @param currentIndex The index to insert the new cell before.
     * @param cellType The type of cell to add ('code' or 'markdown').
     */
    public addCellBefore(currentIndex: number, cellType: 'markdown' | 'code'): void {
        this._insertCellAtIndex(currentIndex, cellType, 'Add Cell Before');
        this.currentSlideIndex = currentIndex;
        this._onDidChangeContent.fire();
    }

    /**
     * Inserts a new cell after the specified index and navigates to it.
     * @param currentIndex The index to insert the new cell after.
     * @param cellType The type of cell to add ('code' or 'markdown').
     */
    public addCellAfter(currentIndex: number, cellType: 'markdown' | 'code'): void {
        const insertAtIndex = currentIndex + 1;
        this._insertCellAtIndex(insertAtIndex, cellType, 'Add Cell After');
        this.currentSlideIndex = insertAtIndex;
        this._onDidChangeContent.fire();
    }

    /**
     * Deletes the cell at the specified index.
     * @param index The index of the cell to delete.
     */
    public deleteCell(index: number): void {
        if (index < 0 || index >= this.cells.length) {
            console.warn(`[IpynbSlideDocument] deleteCell: Invalid index ${index}. Total cells: ${this.cells.length}`);
            return;
        }

        const deletedCell = this._documentData.cells.splice(index, 1)[0];
        const slideIndexBeforeDelete = this._currentSlideIndex;
        console.log(`[IpynbSlideDocument] Deleted cell at index ${index}. New cell count: ${this.cells.length}`);

        // Adjust currentSlideIndex after deletion
        let newCurrentIndex = slideIndexBeforeDelete;
        if (this.cells.length === 0) {
            newCurrentIndex = 0;
        } else if (slideIndexBeforeDelete === index) {
            newCurrentIndex = Math.min(index, this.cells.length - 1);
        } else if (slideIndexBeforeDelete > index) {
            newCurrentIndex = slideIndexBeforeDelete - 1;
        }

        // Use the setter for currentSlideIndex to handle side effects like firing _onDidChangeContent
        // but we also need to fire _onDidChangeContent if the index value didn't change but the underlying data did
        const indexActuallyChanged = this._currentSlideIndex !== newCurrentIndex;
        this._currentSlideIndex = newCurrentIndex;

        if (!indexActuallyChanged) { // If setter didn't fire because value is same, but cell list changed
            this._onDidChangeContent.fire();
        }
        // If indexActuallyChanged, the setter for currentSlideIndex already fired _onDidChangeContent.    

        console.log(`[IpynbSlideDocument] After delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);

        const deletedCellSourcePreview = Array.isArray(deletedCell.source)
            ? deletedCell.source.join('').substring(0, 30)
            : String(deletedCell.source).substring(0, 30);

        this._onDidChangeDocument.fire({
            document: this,
            label: `Delete Cell: "${deletedCellSourcePreview}..."`,
            undo: async () => {
                console.log(`[IpynbSlideDocument] UNDO Delete: Restoring cell at index ${index}`);
                this._documentData.cells.splice(index, 0, deletedCell);
                this.currentSlideIndex = slideIndexBeforeDelete;
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After UNDO Delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            },
            redo: async () => {
                console.log(`[IpynbSlideDocument] REDO Delete: Re-deleting cell at index ${index}`);
                this._documentData.cells.splice(index, 1);
                this.currentSlideIndex = newCurrentIndex;
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After REDO Delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            }
        });
        console.log(`[IpynbSlideDocument] After delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
    }

    /**
     * Clears all outputs from all code cells in the document.
     */
    public clearAllOutputs(): void {
        const originalDocumentData = JSON.parse(JSON.stringify(this._documentData));
        let wasChanged = false;

        const clearedCells = JSON.parse(JSON.stringify(this._documentData.cells));
        clearedCells.forEach((cell: IpynbCell) => {
            if (cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                cell.outputs = [];
                cell.execution_count = null;
                wasChanged = true;
            }
            if (cell.metadata?.slide_show_editor) {
                delete cell.metadata.slide_show_editor;
                wasChanged = true;
            }
        });

        if (!wasChanged) {return;}

        this._documentData.cells = clearedCells;
        this._onDidChangeContent.fire();

        this._onDidChangeDocument.fire({
            document: this,
            label: 'Clear All Outputs',
            undo: async () => {
                console.log(`[IpynbSlideDocument] UNDO: Restoring all outputs.`);
                this._documentData = originalDocumentData;
                this._onDidChangeContent.fire();
            },
            redo: async () => {
                console.log(`[IpynbSlideDocument] REDO: Clearing all outputs again.`);
                this._documentData.cells = clearedCells;
                this._onDidChangeContent.fire();
            }
        });
    }

    /**
     * Updates the source content of a single cell.
     * @param cellIndex The index of the cell to update.
     * @param newSourceString The new source code or markdown content.
     */
    public updateCellSource(cellIndex: number, newSourceString: string): void {
        if (cellIndex < 0 || cellIndex >= this.cells.length) {
            console.warn(`[IpynbSlideDocument] updateCellSource: Invalid index ${cellIndex}.`);
            return;
        }

        const cell = this._documentData.cells[cellIndex];
        if (!cell) {
            console.warn(`[IpynbSlideDocument] updateCellSource: No cell found at index ${cellIndex}.`);
            return;
        }

        // Current source from the document model (likely string[])
        const oldSourceArray: string[] = Array.isArray(cell.source) ? [...cell.source] : [String(cell.source)];
        // Convert newSourceString (from Monaco) to string[] for consistent comparison and storage
        const newSourceArray: string[] = newSourceString.split(/\r?\n/);

        if (JSON.stringify(oldSourceArray) === JSON.stringify(newSourceArray)) {
            console.log(`[IpynbSlideDocument] updateCellSource: No actual change to cell ${cellIndex} content.`);
            return;
        }

        console.log(`[IpynbSlideDocument] Updating source for cell ${cellIndex} and firing _onDidChangeDocument.`);

        cell.source = newSourceArray;
        this._onDidChangeContent.fire();

        this._onDidChangeDocument.fire({
            document: this,
            label: 'Edit Cell Content',
            undo: async () => {
                const cellToUndo = this._documentData.cells[cellIndex];
                if (cellToUndo) {
                    cellToUndo.source = oldSourceArray;
                    this._onDidChangeContent.fire();
                }
            },
            redo: async () => {
                const cellToRedo = this._documentData.cells[cellIndex];
                if (cellToRedo) {
                    cellToRedo.source = newSourceArray;
                    this._onDidChangeContent.fire();
                }
            }
        });
    }

    /**
     * Updates a cell with the results of an execution.
     * @param index The index of the cell to update.
     * @param outputs The array of output objects from the kernel.
     * @param executionData Metadata about the execution, like success and duration.
     */
    public updateCellExecutionResult(index: number, outputs: NotebookOutput[], executionData: { success: boolean; duration: string }): void {
        if (index < 0 || index >= this.cells.length) {return;}

        const cell = this._documentData.cells[index];
        if (cell.cell_type !== 'code') {return;}

        this._executionOrder++;
        cell.execution_count = this._executionOrder;
        cell.outputs = outputs;
        if (!cell.metadata) { cell.metadata = {}; }
        cell.metadata.slide_show_editor = { execution: executionData };

        this._onDidChangeContent.fire();
    }

    /**
     * Resets the execution counter for the entire notebook and clears execution counts from cells.
     */
    public resetExecutionOrder(): void {
        this._executionOrder = 0;
        this._documentData.cells.forEach(cell => {
            if (cell.cell_type === 'code') {
                cell.execution_count = null;
            }
        });
        this._onDidChangeContent.fire();
    }

    // =================================================================
    // VS Code CustomDocument API Implementation
    // =================================================================

    /**
     * Saves the document to its current URI.
     * @param _cancellation A cancellation token.
     */
    async save(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Save operation invoked for ${this.uri.fsPath}.`);
        if (_cancellation.isCancellationRequested) {
            console.log('[IpynbSlideDocument] Save cancelled before starting.');
            return;
        }
        await this.saveAs(this.uri, _cancellation);
        // After a successful save, VS Code will automatically:
        // 1. Clear the "dirty" marker.
        // 2. Update its internal reference for the "saved state" of the document.
        //    The undo stack up to this point will now lead to this saved state.
    }

    /**
     * Saves the document to a specified destination URI.
     * @param destination The target URI to save the file to.
     * @param _cancellation A cancellation token.
     */
    async saveAs(destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Save As operation invoked for ${destination.fsPath}.`);
        if (_cancellation.isCancellationRequested) {
            console.log('[IpynbSlideDocument] Save As cancelled before starting.');
            
            return; // Or throw a cancellation error if preferred by VS Code API for this.
                    // For now, just returning to indicate no save occurred.
        }

        try {
            const  currentDocumentData = this._documentData; // Get the current data
            // Ensure nbformat and nbformat_minor are numbers, defaulting if somehow not.
            // This is already handled well in your constructor, but good to be mindful for serialization.
            const dataToSave: IpynbData = {
                cells: currentDocumentData.cells.map(cell => ({ ...cell })),
                metadata: { ...currentDocumentData.metadata },
                nbformat: typeof currentDocumentData.nbformat === 'number' ? currentDocumentData.nbformat : 4,
                nbformat_minor: typeof currentDocumentData.nbformat_minor === 'number' ? currentDocumentData.nbformat_minor : 5,
            };

            const fileDataString = JSON.stringify(dataToSave, null, 2);
            const fileData = Buffer.from(fileDataString, 'utf8');

            if (_cancellation.isCancellationRequested) {
                console.log('[IpynbSlideDocument] Save As cancelled before writing file.');
                return;
            }

            await vscode.workspace.fs.writeFile(destination, fileData);
            console.log(`[IpynbSlideDocument] Document successfully saved to ${destination.fsPath}`);

            // After a successful save (especially saveAs to a new URI or first save),
            // VS Code typically updates its baseline for the document.
            // If 'destination' is different from 'this.uri', the editor might even re-open
            // for the new URI, or you might need to handle updating 'this.uri'.
            // For now, VS Code's CustomEditor API should handle marking the document clean
            // and updating its internal "saved" state reference upon successful completion
            // of the saveCustomDocumentAs method in the provider.

        } catch (e) {
            console.error(`[IpynbSlideDocument] Error saving document to ${destination.fsPath}:`, e);
            vscode.window.showErrorMessage(`Error saving document: ${(e as Error).message}`);
            throw e;
        }
    }

    /**
     * Reverts the document to its last saved state on disk.
     * @param _cancellation A cancellation token.
     */
    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Revert operation invoked for ${this.uri.fsPath}.`);
        if (_cancellation.isCancellationRequested) {
            console.log('[IpynbSlideDocument] Revert cancelled.');
            return;
        }

        // Store the state *before* revert, for the undo of the revert action itself
        // These variables will be captured by the closures of the undo/redo functions.
        const preRevertDocumentData = JSON.parse(JSON.stringify(this._documentData));

        try {
            await this._doRevert(preRevertDocumentData.cells.length);

        } catch (e) {
            console.error(`[IpynbSlideDocument] Error reverting document ${this.uri.fsPath}:`, e);
            vscode.window.showErrorMessage(`Error reverting document: ${(e as Error).message}`);
            throw e;
        }
    }

    /**
     * Creates a backup of the current document state.
     * @param destination The URI to save the backup to.
     * @param _cancellation A cancellation token.
     * @returns A CustomDocumentBackup object with an ID and a delete method.
     */
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

    // =================================================================
    // Private Methods
    // =================================================================

    private async _doRevert(prevCellLength: number) {
        // 1. Read the file content from disk
        const fileData = await vscode.workspace.fs.readFile(this.uri);
        const jsonString = Buffer.from(fileData).toString('utf8');
        const parsedData = JSON.parse(jsonString || '{}');

        // 2. Reset the internal document data with the re-read content (State S0)
        this._documentData = {
            cells: Array.isArray(parsedData.cells) ? parsedData.cells : [],
            metadata: typeof parsedData.metadata === 'object' && parsedData.metadata !== null ? parsedData.metadata : {},
            nbformat: typeof parsedData.nbformat === 'number' ? parsedData.nbformat : 4,
            nbformat_minor: typeof parsedData.nbformat_minor === 'number' ? parsedData.nbformat_minor : 5,
        };

        // 3. Reset the current slide index (e.g., to the beginning)
        const oldSlideIndexBeforeThisRevertSet = this._currentSlideIndex;
        this.currentSlideIndex = 0;
        
        // Explicitly fire _onDidChangeContent if index was already 0 but cell list changed.
        if (oldSlideIndexBeforeThisRevertSet === 0 && (this._documentData.cells.length !== prevCellLength) ) {
             this._onDidChangeContent.fire();
        }
        // Note: The above 'if' is for the _onDidChangeContent for the revert action itself.
        // The simplified 'if (this._currentSlideIndex === 0)' is for the 'undo of the revert'.

        console.log(`[IpynbSlideDocument] Document reverted. New slide index: ${this._currentSlideIndex}, Total cells: ${this.cells.length}`);
    }

    private _insertCellAtIndex(index: number, cellType: 'markdown' | 'code', undoLabel: string): void {
        if (index < 0 || index > this.cells.length) {
            console.warn(`[IpynbSlideDocument] insertCellAtIndex: Invalid index ${index}.`);
            return;
        }

        const newCell: IpynbCell = {
            cell_type: cellType,
            source: cellType === 'code' ? ['# New Code Cell'] : ['# New Markdown Slide'],
            metadata: {},
            outputs: cellType === 'code' ? [] : undefined,
        };

        const slideIndexBeforeInsert = this._currentSlideIndex;
        this._documentData.cells.splice(index, 0, newCell);

        console.log(`[IpynbSlideDocument] Inserted ${cellType} cell at index ${index}.`);

        // After insertion, typically navigate to the new cell
        const newCurrentIndex = index;
        this._currentSlideIndex = newCurrentIndex;

        this._onDidChangeContent.fire(); // Always fire for webview update
        console.log(`[IpynbSlideDocument] After insert, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);

        this._onDidChangeDocument.fire({
            document: this,
            label: undoLabel,
            undo: async () => {
                console.log(`[IpynbSlideDocument] UNDO Insert: Removing cell at index ${index}`);
                this._documentData.cells.splice(index, 1); // Remove the added cell
                // Restore the slide index to what it was before this insertion
                // or a logical position (e.g., the slide before the insertion point)
                this.currentSlideIndex = slideIndexBeforeInsert;
                // If length is 0, setter will make it 0. If index was > new length, it's clamped.
                // If it was before 'index', it's fine.
                // If it was 'index' or after, it effectively shifts.
                if(this.cells.length > 0 && slideIndexBeforeInsert >= index) { // if original index was at or after insertion point
                    this.currentSlideIndex = Math.min(slideIndexBeforeInsert, this.cells.length -1);
                } else {
                     this.currentSlideIndex = slideIndexBeforeInsert;
                }
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After UNDO Insert, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            },
            redo: async () => {
                console.log(`[IpynbSlideDocument] REDO Insert: Re-inserting cell at index ${index}`);
                this._documentData.cells.splice(index, 0, newCell); // Re-insert the same newCell object
                this.currentSlideIndex = index; // Go to the re-inserted cell
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After REDO Insert, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            }
        });
    }
}