import { marked } from 'marked';
import * as monaco from 'monaco-editor';

// Import Monaco editor core CSS if your bundler/plugin doesn't handle it automatically,
// or if you're managing CSS manually (as in Option B we discussed).
import 'monaco-editor/min/vs/editor/editor.main.css';

// Import your custom CSS files
import '../../media/styles/_base.css';
import '../../media/styles/_layout.css';
import '../../media/styles/_cell_general.css';
import '../../media/styles/_cell_toolbar.css';
import '../../media/styles/_markdown_cell.css';
import '../../media/styles/_code_cell.css';
import '../../media/styles/_code_editor.css';
import '../../media/styles/_output_items.css';

// Import language contributions for syntax highlighting on the main thread.
// These are for Monaco's built-in Monarch tokenizers.
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
// import 'monaco-editor/esm/vs/basic-languages/json/json.contribution.js';
// Add other basic languages as needed.

// --- Monaco Environment Setup for Web Workers ---
// This tells Monaco where to load its worker scripts from.
// The paths are relative to the root of your webview's HTML (likely the 'media' folder).
(globalThis as any).MonacoEnvironment = {
    getWorker: function (_moduleId: string, label: string) {
        let workerPath: string;
        if (label === 'json') {
            workerPath = './json.worker.js';
        } else if (label === 'css' || label === 'scss' || label === 'less') {
            workerPath = './css.worker.js';
        } else if (label === 'html' || label === 'handlebars' || label === 'razor') {
            workerPath = './html.worker.js';
        } else if (label === 'typescript' || label === 'javascript') {
            workerPath = './ts.worker.js';
        } else {
            workerPath = './editor.worker.js'; // Default editor worker
        }

        console.log(`[MonacoEnvironment.getWorker] Creating worker - Label: ${label}, Path: ${workerPath}`);
        const worker = new Worker(workerPath);
        worker.onerror = function(event) {
            console.error(`[Worker onerror] Label: ${label}, Path: ${workerPath}, Message: ${event.message}`, event);
        };
        worker.onmessageerror = function(event) {
            console.error(`[Worker onmessageerror] Label: ${label}, Path: ${workerPath}`, event);
        };
        return worker;
    }
};

// --- Type Definitions ---

interface VsCodeApi {
    postMessage(message: MessageToExtension): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Messages from Extension to Webview
interface UpdateSlideMessage {
    type: 'updateSlide';
    payload: SlidePayload;
}
type MessageFromExtension = UpdateSlideMessage;

// Messages from Webview to Extension
interface ReadyMessage { type: 'ready'; }
interface PreviousMessage { type: 'previous'; }
interface NextMessage { type: 'next'; }
interface RunCellMessage { type: 'runCell'; payload: { slideIndex: number }; }
interface DeleteCellMessage { type: 'deleteCell'; payload: { slideIndex: number }; } // Kept for direct calls if needed, though requestDeleteConfirmation is primary
interface RequestDeleteConfirmationMessage { type: 'requestDeleteConfirmation'; payload: { slideIndex: number }; }

type MessageToExtension =
    | ReadyMessage
    | PreviousMessage
    | NextMessage
    | RunCellMessage
    | DeleteCellMessage
    | RequestDeleteConfirmationMessage;

// Notebook Structure Types
type Source = string | string[];

interface BaseCell {
    cell_type: string;
    source: Source;
    metadata: Record<string, any>;
}

interface MarkdownCell extends BaseCell {
    cell_type: 'markdown';
}

interface CodeCell extends BaseCell {
    cell_type: 'code';
    outputs?: Output[];
    execution_count?: number | null;
}

type NotebookCell = MarkdownCell | CodeCell;

// Output Types
interface StreamOutput { output_type: 'stream'; name: 'stdout' | 'stderr'; text: Source; }
interface DataBundle { [mimeType: string]: Source; }
interface DisplayDataOutput { output_type: 'display_data'; data: DataBundle; metadata?: Record<string, any>; }
interface ExecuteResultOutput { output_type: 'execute_result'; execution_count: number | null; data: DataBundle; metadata?: Record<string, any>; }
interface ErrorOutput { output_type: 'error'; ename: string; evalue: string; traceback: string[]; }
type Output = StreamOutput | DisplayDataOutput | ExecuteResultOutput | ErrorOutput;

// Payload for 'updateSlide' message
interface SlidePayload {
    cell: NotebookCell | null;
    slideIndex: number;
    totalSlides: number;
    notebookLanguage: string;
}

// --- Main Webview Script ---

console.log('[PreviewScript] Initializing...');
const vscode = acquireVsCodeApi();

const contentDiv = document.getElementById('slide-content') as HTMLDivElement | null;
const prevButton = document.getElementById('prev-button') as HTMLButtonElement | null;
const nextButton = document.getElementById('next-button') as HTMLButtonElement | null;
const indicatorSpan = document.getElementById('slide-indicator') as HTMLSpanElement | null;

let currentMonacoEditor: monaco.editor.IStandaloneCodeEditor | null = null;

function sourceToString(source: Source): string {
    return Array.isArray(source) ? source.join('') : source;
}

window.addEventListener('message', (event: MessageEvent<MessageFromExtension>) => {
    const message = event.data;
    console.log('[PreviewScript] Received message:', message.type, message.payload);
    switch (message.type) {
        case 'updateSlide':
            if (message.payload) {
                renderSlide(message.payload);
                updateControls(message.payload.slideIndex, message.payload.totalSlides);
            } else {
                console.warn('[PreviewScript] updateSlide message received with no payload.');
            }
            break;
        default:
            console.warn('[PreviewScript] Received unknown message type:', message.type);
    }
});

window.addEventListener('keydown', (event: KeyboardEvent) => {
    // console.log('[PreviewScript] Keydown event:', event.key); // For debugging

    // Prevent interference if user is typing in an input field, textarea, or contenteditable
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        // Also check if inside Monaco Editor - Monaco handles its own arrow keys
        // Check if the target is inside a Monaco editor instance
        if (currentMonacoEditor && currentMonacoEditor.getDomNode()?.contains(target)) {
            return; // Let Monaco handle its keys
        }
        // If it's a generic input/textarea outside Monaco, allow default arrow key behavior
        // return; // Or, if you want arrows to always navigate slides, remove this block
    }


    switch (event.key) {
        case 'ArrowLeft':
            console.log('[PreviewScript] ArrowLeft pressed, posting "previous"');
            vscode.postMessage({ type: 'previous' });
            event.preventDefault(); // Prevent default browser action for arrow keys (e.g., scrolling)
            break;
        case 'ArrowRight':
            console.log('[PreviewScript] ArrowRight pressed, posting "next"');
            vscode.postMessage({ type: 'next' });
            event.preventDefault(); // Prevent default browser action
            break;
    }
});

function createCellToolbar(cell: NotebookCell, slideIndex: number): HTMLDivElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'cell-toolbar';

    
    // This spacer will push subsequent items to the right if a run button isn't present
    // or if we want more explicit control than just margin-right: auto on the run button.
    // An alternative is to have two groups of buttons, one left-aligned, one right-aligned.
    // For now, margin-right: auto on .run-button is simpler. If no run button, delete will be on left.
    // To ensure delete is always on the right, we need a different flex setup or a spacer.

    // Let's refine for: Run button always left (if present). Other buttons always right.
    // We can achieve this by having a left group and a right group, and a spacer.
    // Or, simpler: one button with margin-right: auto, and others naturally flow after.
    // The current CSS targets .run-button with margin-right: auto.
    // If there's no run button, the delete button will be the first item.
    // If we want Delete to always be on the right, we need a different approach.

    // Simpler approach for now: Keep all buttons together and use justify-content on toolbar.
    // For "Run left, others right":
    // 1. Add Run button
    // 2. Add a spacer div with flex-grow: 1
    // 3. Add other buttons (Delete, More)

    // Let's refine:
    const leftActions = document.createElement('div');
    leftActions.className = 'toolbar-actions-left'; // Style this with display:flex

    const rightActions = document.createElement('div');
    rightActions.className = 'toolbar-actions-right'; // Style this with display:flex

    // Add "Run" button for code cells (will be pushed to the left by CSS)
    if (cell.cell_type === 'code') {
        const runButton = document.createElement('button');
        runButton.className = 'cell-action-button run-button';
        runButton.textContent = '▶ Run';
        runButton.title = 'Run Cell';
        runButton.onclick = () => {
            console.log(`[PreviewScript] Posting 'runCell' for index ${slideIndex}`);
            vscode.postMessage({ type: 'runCell', payload: { slideIndex } });
        };
        leftActions.appendChild(runButton);
    }

    const deleteButton = document.createElement('button');
    deleteButton.className = 'cell-action-button delete-button';
    deleteButton.textContent = '🗑 Delete';
    deleteButton.title = 'Delete Cell';
    deleteButton.onclick = () => {
        console.log(`[PreviewScript] Posting 'requestDeleteConfirmation' for index ${slideIndex}`);
        vscode.postMessage({ type: 'requestDeleteConfirmation', payload: { slideIndex } });
    };    
    rightActions.appendChild(deleteButton);


    // TODO: Add "More Actions" button to rightActions
    // const moreButton = document.createElement('button');
    // moreButton.className = 'cell-action-button more-button';
    // moreButton.textContent = '...';
    // rightActions.appendChild(moreButton);


    toolbar.appendChild(leftActions);
    // If leftActions is empty, this spacer won't do much if rightActions is also empty.
    // If only rightActions has content, it will be pushed to right by this spacer.
    const spacer = document.createElement('div');
    spacer.style.flexGrow = '1'; // This pushes rightActions to the end
    toolbar.appendChild(spacer);
    toolbar.appendChild(rightActions);
    
    
    return toolbar;
}

function renderSlide(payload: SlidePayload): void {
    if (!contentDiv) {
        console.error("[PreviewScript] renderSlide: contentDiv not found!");
        return;
    }
    console.log(`[PreviewScript] renderSlide called. Cell type: ${payload.cell?.cell_type}, Slide Index: ${payload.slideIndex}`);
    contentDiv.innerHTML = ''; // Clear previous slide

    if (currentMonacoEditor) {
        console.log("[PreviewScript] Disposing previous Monaco editor instance.");
        currentMonacoEditor.dispose();
        currentMonacoEditor = null;
    }

    const cell = payload.cell;
    if (!cell) {
        contentDiv.textContent = 'No slide data available.';
        return;
    }

    const cellContainerDiv = document.createElement('div');
    cellContainerDiv.className = `cell ${cell.cell_type}-cell`; // Dynamic class for cell type
    cellContainerDiv.dataset.slideIndex = payload.slideIndex.toString();

    const toolbar = createCellToolbar(cell, payload.slideIndex);
    cellContainerDiv.appendChild(toolbar);

    if (cell.cell_type === 'markdown') {
        const mkDiv = document.createElement('div');
        mkDiv.className = 'markdown-content';
        mkDiv.innerHTML = marked.parse(sourceToString(cell.source)) as string;
        cellContainerDiv.appendChild(mkDiv);
    } else if (cell.cell_type === 'code') {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'code-cell-body';

        const editorContainer = document.createElement('div');
        editorContainer.className = 'code-editor-container';
        bodyDiv.appendChild(editorContainer);

        console.log('[PreviewScript] Cell metadata for code cell:', JSON.stringify(cell.metadata, null, 2));
        const cellSpecificLanguage = (cell.metadata?.language_info?.name || cell.metadata?.kernelspec?.language);
        const language = (cellSpecificLanguage || payload.notebookLanguage || 'plaintext').toLowerCase();
        console.log(`[PreviewScript] Monaco language for cell index ${payload.slideIndex}: "${language}"`);

        const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
            value: sourceToString(cell.source),
            language: language,
            theme: 'vs-dark', // Consider deriving from VS Code theme
            readOnly: true,   // For now
            lineNumbers: 'on',
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on', // 'on' is good for slides
            // contextmenu: false, // Optionally disable Monaco's context menu
        };

        try {
            currentMonacoEditor = monaco.editor.create(editorContainer, editorOptions);
            console.log(`[PreviewScript] Monaco editor instance created for cell index ${payload.slideIndex}`);
        } catch (e) {
            console.error("[PreviewScript] Error creating Monaco editor instance:", e);
            if (editorContainer) {
                editorContainer.textContent = "Error creating Monaco editor: " + (e as Error).message;
            }
        }

        if (cell.outputs && cell.outputs.length > 0) {
            const outputWrapperDiv = document.createElement('div');
            outputWrapperDiv.className = 'cell-output-wrapper';
            const outputDiv = document.createElement('div');
            outputDiv.className = 'code-output';
            cell.outputs.forEach(output => renderOutput(output, outputDiv));
            if (outputDiv.hasChildNodes()) {
                outputWrapperDiv.appendChild(outputDiv);
                bodyDiv.appendChild(outputWrapperDiv);
            }
        }
        cellContainerDiv.appendChild(bodyDiv);
    } else {
        const unknownDiv = document.createElement('div');
        unknownDiv.className = 'unknown-content';
        unknownDiv.textContent = `Unsupported cell type: \n${JSON.stringify(cell, null, 2)}`;
        cellContainerDiv.appendChild(unknownDiv);
    }
    contentDiv.appendChild(cellContainerDiv);
}

function renderOutput(output: Output, container: HTMLElement): void {
    const outputElement = document.createElement('div');
    outputElement.className = `output-item output-${output.output_type}`;
    let renderedContent = false;

    switch (output.output_type) {
        case 'stream':
            const streamPre = document.createElement('pre');
            streamPre.className = `output-stream output-${output.name}`;
            streamPre.textContent = sourceToString(output.text);
            outputElement.appendChild(streamPre);
            renderedContent = true;
            break;
        case 'display_data':
        case 'execute_result':
            const data = output.data;
            if (data['text/html']) {
                const htmlDiv = document.createElement('div');
                htmlDiv.className = 'output-html';
                // WARNING: Sanitize untrusted HTML
                htmlDiv.innerHTML = sourceToString(data['text/html']);
                outputElement.appendChild(htmlDiv);
                renderedContent = true;
            } else if (data['image/svg+xml']) {
                const svgDiv = document.createElement('div');
                svgDiv.className = 'output-svg';
                // WARNING: Sanitize untrusted SVG
                svgDiv.innerHTML = sourceToString(data['image/svg+xml']);
                outputElement.appendChild(svgDiv);
                renderedContent = true;
            } else if (data['image/png']) {
                const img = document.createElement('img');
                img.className = 'output-image';
                img.src = `data:image/png;base64,${sourceToString(data['image/png'])}`;
                outputElement.appendChild(img);
                renderedContent = true;
            } else if (data['image/jpeg']) {
                const img = document.createElement('img');
                img.className = 'output-image';
                img.src = `data:image/jpeg;base64,${sourceToString(data['image/jpeg'])}`;
                outputElement.appendChild(img);
                renderedContent = true;
            } else if (data['text/plain']) {
                const textPre = document.createElement('pre');
                textPre.className = 'output-text';
                textPre.textContent = sourceToString(data['text/plain']);
                outputElement.appendChild(textPre);
                renderedContent = true;
            } else if (Object.keys(data).length > 0) { // Fallback for other data types
                const fallbackPre = document.createElement('pre');
                fallbackPre.textContent = `Unsupported MIME type(s): ${Object.keys(data).join(', ')}\nData: ${JSON.stringify(data, null, 2).substring(0, 500)}`;
                outputElement.appendChild(fallbackPre);
                renderedContent = true;
            }
            break;
        case 'error':
            const errorPre = document.createElement('pre');
            errorPre.className = 'output-error';
            // Consider ansi-to-html library for tracebacks with ANSI colors
            const tracebackText = output.traceback ? output.traceback.join('\n') : `${output.ename}: ${output.evalue}`;
            errorPre.textContent = tracebackText;
            outputElement.appendChild(errorPre);
            renderedContent = true;
            break;
        default:
            const defaultPre = document.createElement('pre');
            const unknownOutput = output as any;
            defaultPre.textContent = `Unknown output type: ${unknownOutput.output_type}\n${JSON.stringify(unknownOutput, null, 2)}`;
            outputElement.appendChild(defaultPre);
            renderedContent = true;
    }

    if (renderedContent && outputElement.hasChildNodes()) {
        container.appendChild(outputElement);
    }
}

function updateControls(currentIndex: number, totalSlides: number): void {
    if (!indicatorSpan || !prevButton || !nextButton) {
        console.warn('[PreviewScript] Control elements not found in updateControls.');
        return;
    }
    if (totalSlides > 0) {
        indicatorSpan.textContent = `${currentIndex + 1} / ${totalSlides}`;
        prevButton.disabled = currentIndex <= 0;
        nextButton.disabled = currentIndex >= totalSlides - 1;
    } else {
        indicatorSpan.textContent = '0 / 0';
        prevButton.disabled = true;
        nextButton.disabled = true;
    }
}

// --- Event Listeners for Main Controls ---
if (prevButton) {
    prevButton.addEventListener('click', () => {
        console.log("[PreviewScript] Previous button clicked");
        vscode.postMessage({ type: 'previous' });
    });
} else {
    console.warn("[PreviewScript] Previous button not found.");
}

if (nextButton) {
    nextButton.addEventListener('click', () => {
        console.log("[PreviewScript] Next button clicked");
        vscode.postMessage({ type: 'next' });
    });
} else {
    console.warn("[PreviewScript] Next button not found.");
}

// --- Initialization ---
if (contentDiv) {
    contentDiv.textContent = 'Initializing slide preview...'; // Initial placeholder
} else {
    console.error("[PreviewScript] Main contentDiv not found on initial load!");
    document.body.innerHTML = '<p style="color:red; font-size:18px;">Error: Webview content area not found. Preview cannot load.</p>';
}

console.log("[PreviewScript] Sending 'ready' message to extension host.");
vscode.postMessage({ type: 'ready' });