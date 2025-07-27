export interface VsCodeApi {
    postMessage(message: MessageToExtension): void;
}

// MESSAGES

// Messages from Extension to Webview
export interface UpdateMessage {
    type: 'update';
    payload: SlidePayload;
}
export type MessageFromExtension = UpdateMessage;
    

// Messages from Webview to Extension
export interface RunAllMessage { type: 'runAll' }
export interface ClearOutputsMessage { type: 'clearAllOutputs' }
export interface RestartKernelMessage { type: 'restartKernel' }
export interface GlobalUndoMessage { type: 'requestGlobalUndo' }
export interface GlobalRedoMessage { type: 'requestGlobalRedo' }
export interface CellContentChangedMessage { type: 'cellContentChanged'; payload: {slideIndex: number; newSource: string; }; }
export interface ReadyMessage { type: 'ready'; }
export interface PreviousMessage { type: 'previous'; }
export interface NextMessage { type: 'next'; }
export interface KernelSelectionMessage { type: 'requestKernelSelection' }
export interface RunCellMessage { type: 'runCell'; payload: { slideIndex: number }; }
export interface DeleteCellMessage { type: 'deleteCell'; payload: { slideIndex: number }; } // Kept for direct calls if needed, though requestDeleteConfirmation is primary
export interface RequestDeleteConfirmationMessage { type: 'requestDeleteConfirmation'; payload: { slideIndex: number }; }
export interface AddCellBeforeMessage {
    type: 'addCellBefore';
    payload: {
        currentSlideIndex: number; // The index of the slide *before* which to add
        cellType: 'markdown' | 'code';
    };
}

export interface AddCellAfterMessage {
    type: 'addCellAfter';
    payload: {
        currentSlideIndex: number; // The index of the slide *after* which to add
        cellType: 'markdown' | 'code';
    };
}

export interface TogglePresentationModeMessage { type: 'togglePresentationMode'; }

export type MessageToExtension =
      AddCellBeforeMessage
    | TogglePresentationModeMessage
    | AddCellAfterMessage
    | KernelSelectionMessage
    | ReadyMessage
    | GlobalRedoMessage
    | GlobalUndoMessage
    | PreviousMessage
    | NextMessage
    | RunCellMessage
    | RestartKernelMessage
    | DeleteCellMessage
    | RequestDeleteConfirmationMessage
    | CellContentChangedMessage
    | RunAllMessage
    | ClearOutputsMessage;

// NOTEBOOK STRUCTURE
export type Source = string | string[];

export interface BaseCell {
    cell_type: string;
    source: Source;
    metadata: Record<string, any>;
}

export interface MarkdownCell extends BaseCell {
    cell_type: 'markdown';
}

export interface CodeCell extends BaseCell {
    cell_type: 'code';
    outputs?: any[]; // Keep this simple or export all output types
    execution_count?: number | null;
}

export type NotebookCell = MarkdownCell | CodeCell;

// PAYLOAD
export interface SlidePayload {
    cell: NotebookCell | null;
    slideIndex: number;
    totalSlides: number;
    notebookLanguage: string;
    controllerName: string;
    executionSuccess: boolean;
    kernelStatus?: 'idle' | 'busy';
    isInPresentationMode?: boolean;
}


// OUTPUT TYPES
export interface StreamOutput { output_type: 'stream'; name: 'stdout' | 'stderr'; text: Source; }
export interface DataBundle { [mimeType: string]: Source; }
export interface DisplayDataOutput { output_type: 'display_data'; data: DataBundle; metadata?: Record<string, any>; }
export interface ExecuteResultOutput { output_type: 'execute_result'; execution_count: number | null; data: DataBundle; metadata?: Record<string, any>; }
export interface ErrorOutput { output_type: 'error'; ename: string; evalue: string; traceback: string[]; }
export type Output = StreamOutput | DisplayDataOutput | ExecuteResultOutput | ErrorOutput;

