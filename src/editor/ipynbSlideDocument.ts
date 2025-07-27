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

    public getNotebookData(): IpynbData {
        return this._documentData;
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
        if (index < 0 || index > this.cells.length) {
            console.warn(`[IpynbSlideDocument] insertCellAtIndex: Invalid index ${index}.`);
            return;
        }
    
        const newCellSource = cellType === 'code' ? ['# New Code Cell'] : ['# New Markdown Slide'];
        const newCell: IpynbCell = { /* ... create newCell ... */
            cell_type: cellType,
            source: newCellSource,
            metadata: {},
            outputs: cellType === 'code' ? [] : undefined,
        };
    
        const slideIndexBeforeInsert = this._currentSlideIndex;
    
        // Perform the insertion
        this._documentData.cells.splice(index, 0, newCell);
        console.log(`[IpynbSlideDocument] Inserted ${cellType} cell at index ${index}.`);
    
        // After insertion, typically navigate to the new cell
        const newCurrentIndex = index;
        const indexActuallyChanged = this._currentSlideIndex !== newCurrentIndex;
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

    public clearAllOutputs(): void {
        // Make a deep copy of the current document state for the undo action.
        const originalDocumentData = JSON.parse(JSON.stringify(this._documentData));
        let wasChanged = false;

        // We still create a new copy to modify
        const clearedCells = JSON.parse(JSON.stringify(this._documentData.cells));
        clearedCells.forEach((cell: IpynbCell) => {
            if (cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
                cell.outputs = [];
                cell.execution_count = null;
                wasChanged = true;
            }

            // Also check if there is execution metadata to clear
            if (cell.metadata?.slide_show_editor) {
                delete cell.metadata.slide_show_editor;
                wasChanged = true; 
            }
        });

        // Only proceed if a change was actually made.
        if (wasChanged) {
            console.log(`[IpynbSlideDocument] Cleared all outputs for ${this.uri.fsPath}`);

            this._documentData.cells = clearedCells;
            // Fire this event to trigger a UI update in the webview.
            this._onDidChangeContent.fire();

            // Fire this event to register the entire operation with VS Code's undo/redo stack.
            this._onDidChangeDocument.fire({
                document: this,
                label: 'Clear All Outputs',
                undo: async () => {
                    console.log(`[IpynbSlideDocument] UNDO: Restoring all outputs.`);
                    this._documentData = originalDocumentData;
                    this._onDidChangeContent.fire(); // Notify webview to re-render with restored outputs.
                },
                redo: async () => {
                    console.log(`[IpynbSlideDocument] REDO: Clearing all outputs again.`);
                    this._documentData.cells = clearedCells;
                    this._onDidChangeContent.fire();
                }
            });
        } else {
            console.log(`[IpynbSlideDocument] No outputs to clear for ${this.uri.fsPath}`);
        }
    }

    public deleteCell(index: number): void {
        if (index < 0 || index >= this.cells.length) {
            console.warn(`[IpynbSlideDocument] deleteCell: Invalid index ${index}. Total cells: ${this.cells.length}`);
            return;
        }

        const documentSnapshotForUndo = JSON.parse(JSON.stringify(this._documentData));
        const deletedCellForRedo = JSON.parse(JSON.stringify(this._documentData.cells[index])); // Keep a copy of the cell itself for redo
        const slideIndexBeforeDelete = this._currentSlideIndex;

        // const oldDocumentData = JSON.parse(JSON.stringify(this._documentData));
        // const oldSlideIndex = this._currentSlideIndex;

        const deletedCell = this._documentData.cells.splice(index, 1)[0];
        const deletedCellSourcePreview = Array.isArray(deletedCell.source)
            ? deletedCell.source.join('').substring(0, 30)
            : String(deletedCell.source).substring(0, 30);

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

        this._onDidChangeDocument.fire({
            document: this,
            label: `Delete Cell: "${deletedCellSourcePreview}..."`,
            undo: async () => {
                console.log(`[IpynbSlideDocument] UNDO Delete: Restoring cell at index ${index}`);
                // Restore the cell by inserting it back
                this._documentData.cells.splice(index, 0, deletedCell); // Re-insert the actual deleted cell
                // Restore the slide index to what it was before this deletion
                this.currentSlideIndex = slideIndexBeforeDelete;
                // If currentSlideIndex value didn't change from what it was just before calling undo,
                // but data did change (cell reinserted), ensure webview updates.
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After UNDO Delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            },
            redo: async () => {
                console.log(`[IpynbSlideDocument] REDO Delete: Re-deleting cell at index ${index}`);
                // Re-perform the deletion.
                this._documentData.cells.splice(index, 1);
                // Recalculate currentSlideIndex as done in the original delete
                this.currentSlideIndex = newCurrentIndex; // Use the index calculated during the original delete
                this._onDidChangeContent.fire();
                console.log(`[IpynbSlideDocument] After REDO Delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
            }
        });
        console.log(`[IpynbSlideDocument] After delete, current slide index: ${this.currentSlideIndex}, total slides: ${this.cells.length}`);
    }

    // --- Methods Required by CustomEditorProvider (Stubs for a Read-Only/Preview Focus) ---

    async save(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Save operation invoked for ${this.uri.fsPath}.`);
        if (_cancellation.isCancellationRequested) {
            console.log('[IpynbSlideDocument] Save cancelled before starting.');
            return;
        }
        // Delegate to saveAs with the current document URI
        await this.saveAs(this.uri, _cancellation);
        // After a successful save, VS Code will automatically:
        // 1. Clear the "dirty" marker.
        // 2. Update its internal reference for the "saved state" of the document.
        //    The undo stack up to this point will now lead to this saved state.
    
    }

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
                cells: currentDocumentData.cells.map(cell => ({ ...cell })), // Create shallow copies of cells
                metadata: { ...currentDocumentData.metadata }, // Shallow copy of metadata
                nbformat: typeof currentDocumentData.nbformat === 'number' ? currentDocumentData.nbformat : 4,
                nbformat_minor: typeof currentDocumentData.nbformat_minor === 'number' ? currentDocumentData.nbformat_minor : 5,
            };
    
            const fileDataString = JSON.stringify(dataToSave, null, 2); // Pretty print with 2 spaces
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
            throw e; // Re-throw so VS Code knows the operation failed.
        }
    }

    async _doRevert(prevCellLength: number) {
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
        const oldSlideIndexBeforeThisRevertSet = this._currentSlideIndex; // Value before setting to 0
        this.currentSlideIndex = 0; // Setter fires _onDidChangeContent if value changes from oldSlideIndexBeforeThisRevertSet

        // Explicitly fire _onDidChangeContent if index was already 0 but cell list changed.
        if (oldSlideIndexBeforeThisRevertSet === 0 && (this._documentData.cells.length !== prevCellLength) ) {
             this._onDidChangeContent.fire();
        }
        // Note: The above 'if' is for the _onDidChangeContent for the revert action itself.
        // The simplified 'if (this._currentSlideIndex === 0)' is for the 'undo of the revert'.

        console.log(`[IpynbSlideDocument] Document reverted. New slide index: ${this._currentSlideIndex}, Total cells: ${this.cells.length}`);
    }

    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        console.log(`[IpynbSlideDocument] Revert operation invoked for ${this.uri.fsPath}.`);
        if (_cancellation.isCancellationRequested) {
            console.log('[IpynbSlideDocument] Revert cancelled.');
            return;
        }
    
        // Store the state *before* revert, for the undo of the revert action itself
        // These variables will be captured by the closures of the undo/redo functions.
        const preRevertDocumentData = JSON.parse(JSON.stringify(this._documentData));
        // const preRevertSlideIndex = this._currentSlideIndex;
        // const _restorePrev = () => {
        //     this._documentData = preRevertDocumentData; // state becomes S1_data
        //     this.currentSlideIndex = preRevertSlideIndex; // state becomes S1_index

        //     // Fire _onDidChangeContent for webview update to S1 state
        //     // Simplified logic: setter fires if index changed from 0, else we fire if index is now 0.
        //     if (this._currentSlideIndex === 0) {
        //         this._onDidChangeContent.fire();
        //     }
        // }
    
        try {
            this._doRevert(preRevertDocumentData.cells.length);
            
        } catch (e) {
            console.error(`[IpynbSlideDocument] Error reverting document ${this.uri.fsPath}:`, e);
            vscode.window.showErrorMessage(`Error reverting document: ${(e as Error).message}`);
            throw e; // Re-throw to let VS Code know the operation failed
        }
    }
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
    
        // Simple check to see if content actually changed
        // For more robust check, compare array contents element by element or stringified versions
        if (JSON.stringify(oldSourceArray) === JSON.stringify(newSourceArray)) {
            console.log(`[IpynbSlideDocument] updateCellSource: No actual change to cell ${cellIndex} content.`);
            return;
        }
    
        console.log(`[IpynbSlideDocument] Updating source for cell ${cellIndex} and firing _onDidChangeDocument.`);
    
        // Update the document data
        cell.source = newSourceArray;

        // Notify listeners (like the provider) that the document's content has changed.
        // This will trigger the webview to be updated with the new data.
        this._onDidChangeContent.fire();
    
        // Fire _onDidChangeDocument to make this edit undoable
        this._onDidChangeDocument.fire({
            document: this,
            label: 'Edit Cell Content',
            undo: async () => {
                console.log(`[IpynbSlideDocument] UNDO Edit Cell Content: Index ${cellIndex}`);
                const cellToUndo = this._documentData.cells[cellIndex];
                if (cellToUndo) {
                    cellToUndo.source = oldSourceArray; // Restore the old source (which was a string[])
                    this._onDidChangeContent.fire(); // Notify webview to re-render with oldSource
                }
            },
            redo: async () => {
                console.log(`[IpynbSlideDocument] REDO Edit Cell Content: Index ${cellIndex}`);
                const cellToRedo = this._documentData.cells[cellIndex];
                if (cellToRedo) {
                    cellToRedo.source = newSourceArray; // Restore the new source (which was a string[])
                    this._onDidChangeContent.fire(); // Notify webview to re-render with newSource
                }
            }
        });
    }

    public updateCellExecutionResult(
        index: number, 
        outputs: NotebookOutput[], 
        executionData: { success: boolean; duration: string }
    ): void {
        if (index < 0 || index >= this.cells.length) {return;}

        const cell = this._documentData.cells[index];
        if (cell.cell_type !== 'code') {return;}

        // 1. Save the original state of just this cell for the undo action.
        const originalCellState = JSON.parse(JSON.stringify(cell));

        // 2. Apply all new data to the cell.
        cell.outputs = outputs;
        cell.execution_count = (cell.execution_count || 0) + 1;
        if (!cell.metadata) {cell.metadata = {};}
        cell.metadata.slide_show_editor = { execution: executionData };

        // 3. Fire the events.
        this._onDidChangeContent.fire();
        
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