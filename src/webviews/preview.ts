import { marked } from 'marked';

import { EditorManager } from './editorManager'; // Imports the manager
import { NotebookCell, SlidePayload, VsCodeApi, MessageFromExtension, MarkdownCell, Output } from './types'; // Imports shared types
import { sourceToString } from './utils'; // Imports shared utils

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
import '../../media/styles/_slide_add_controls.css';

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


declare function acquireVsCodeApi(): VsCodeApi;


// --- Main Webview Script ---

console.log('[PreviewScript] Initializing...');
const vscode = acquireVsCodeApi();
EditorManager.initialize(vscode);

const contentDiv = document.getElementById('slide-content') as HTMLDivElement | null;
const prevButton = document.getElementById('prev-button') as HTMLButtonElement | null;
const nextButton = document.getElementById('next-button') as HTMLButtonElement | null;
const indicatorSpan = document.getElementById('slide-indicator') as HTMLSpanElement | null;
const addSlideLeftButton = document.getElementById('add-slide-left-button') as HTMLButtonElement | null;
const addSlideRightButton = document.getElementById('add-slide-right-button') as HTMLButtonElement | null;


let currentPayloadSlideIndex: number | undefined;
let lastReceivedPayload: SlidePayload | undefined;

window.addEventListener('message', (event: MessageEvent<MessageFromExtension>) => {
    const message = event.data;
    console.log('[PreviewScript] Received message:', message.type, message.payload);
    switch (message.type) {
        case 'updateSlide':
            if (message.payload) {
                lastReceivedPayload = message.payload;
                currentPayloadSlideIndex = message.payload.slideIndex;
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
    
    // If our editor manager has an active editor and it has focus,
    // let the editor's own keydown handler (inside EditorManager) do all the work.
    // This prevents ArrowLeft/ArrowRight from navigating slides while typing in an editor.
    if (EditorManager.activeEditor?.hasTextFocus()) {
        return;
    }


    // Prevent interference if user is typing in an input field, textarea, or contenteditable
    const target = event.target as HTMLElement;
    
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        // If focus is in a non-Monaco input/textarea, allow most keys.
        // We only want to intercept global arrow keys for slide navigation
        // if we are NOT in such an input.
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            // Let the input field handle arrows
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.shiftKey) ){
            // Let input field handle these compound Enter presses
            return;
        }
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
        // Add other keys if needed, e.g., Space for next, Shift+Space for previous
        // case ' ':
        //     vscode.postMessage({ type: 'next' });
        //     event.preventDefault();
        //     break;
    }
});

function createCellToolbar(cell: NotebookCell, slideIndex: number, cellContainerElement: HTMLDivElement): HTMLDivElement {
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
    } else if (cell.cell_type === 'markdown') {
        const toggleEditButton = document.createElement('button');
        toggleEditButton.className = 'cell-action-button markdown-toggle-edit-button';
        
        toggleEditButton.title = 'Edit Markdown';
        toggleEditButton.onclick = () => {
            const body = cellContainerElement.querySelector('.markdown-cell-body');
            if (body) {
                EditorManager.toggleMarkdownEdit(slideIndex, cellContainerElement, cell as MarkdownCell);
            }        
        };
        leftActions.appendChild(toggleEditButton); // Place it on the left for now
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
    if (!contentDiv) { return; }
    console.log(`[PreviewScript] renderSlide called for slide ${payload.slideIndex}`);

    // If we get an update for the slide that already has an active editor,
    // we just update its content instead of doing a disruptive full re-render.
    if (EditorManager.activeEditor && EditorManager.activeEditorInfo?.slideIndex === payload.slideIndex && payload.cell) {
        const newSource = sourceToString(payload.cell.source);
        const editorModel = EditorManager.activeEditor.getModel();

        // Only update if the content is actually different, to avoid moving the cursor needlessly.
        if (editorModel && editorModel.getValue() !== newSource) {
            console.log(`[PreviewScript] renderSlide: Applying non-destructive update to active editor for slide ${payload.slideIndex}`);
            
            // Push an edit to the model. This is better than `setValue` because it
            // allows Monaco to create a proper undo/redo step within its own buffer.
            const fullRange = editorModel.getFullModelRange();
            editorModel.pushEditOperations(
                [], // Previous selections
                [{ range: fullRange, text: newSource }],
                () => null // New selections
            );

            // After programmatically changing the content, we must also update
            // our 'initialSource' baseline to prevent thinking this is a new user edit.
            EditorManager.activeEditorInfo.initialSource = newSource;
        }


        // The editor is updated, but the toolbar's event listeners are still stale.
        // We must rebuild the toolbar to give it fresh closures with the new payload data.
        const cellContainerDiv = EditorManager.activeEditorInfo.cellContainer.closest('.cell') as HTMLDivElement | null;
        if (cellContainerDiv) {
            const oldToolbar = cellContainerDiv.querySelector('.cell-toolbar');
            if (oldToolbar) {
                console.log('[PreviewScript] Re-binding toolbar listeners with fresh cell data.');
                const newToolbar = createCellToolbar(payload.cell, payload.slideIndex, cellContainerDiv);
                oldToolbar.replaceWith(newToolbar);
            }
        }

        // IMPORTANT: After this non-destructive update, we stop. We do not proceed
        // to the full re-render logic below.
        return;
    }

    // Call EditorManager.disposeCurrent() at the very beginning.
    // This commits any pending changes and cleans up the editor from the previous slide.
    EditorManager.disposeCurrent();

    contentDiv.innerHTML = ''; // Clear previous slide

    const cell = payload.cell;
    if (!cell) {
        contentDiv.textContent = 'No slide data available.';
        return;
    }


    const cellContainerDiv = document.createElement('div');
    cellContainerDiv.className = `cell ${cell.cell_type}-cell`; // Dynamic class for cell type
    cellContainerDiv.dataset.slideIndex = payload.slideIndex.toString();

    const toolbar = createCellToolbar(cell.cell_type === 'code' ? cell : payload.cell as MarkdownCell, payload.slideIndex, cellContainerDiv);
    cellContainerDiv.appendChild(toolbar);

    if (cell.cell_type === 'markdown') {

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'markdown-cell-body';

        // This container shows the rendered HTML.
        const renderedContentDiv = document.createElement('div');
        renderedContentDiv.className = 'markdown-content';
        renderedContentDiv.innerHTML = marked.parse(sourceToString(cell.source)) as string;
        renderedContentDiv.style.display = '';
        bodyDiv.appendChild(renderedContentDiv);
        
        // This container is a placeholder for where the editor will go when toggled.
        const editorWrapper = document.createElement('div');
        editorWrapper.className = 'markdown-editor-wrapper';
        bodyDiv.appendChild(editorWrapper);

        cellContainerDiv.appendChild(bodyDiv);

    } else if (cell.cell_type === 'code') {

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'code-cell-body';

        const editorContainer = document.createElement('div');
        editorContainer.className = 'code-editor-container';
        bodyDiv.appendChild(editorContainer);

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

        const language = (cell.metadata?.language_info?.name || payload.notebookLanguage || 'plaintext').toLowerCase();
        EditorManager.create(
            editorContainer,
            payload.slideIndex,
            language,
            sourceToString(cell.source)
        );

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

if (addSlideLeftButton) {
    addSlideLeftButton.addEventListener('click', () => {
        if (typeof currentPayloadSlideIndex === 'number') {
            console.log(`[PreviewScript] Posting 'addCellBefore' current index ${currentPayloadSlideIndex}`);
            vscode.postMessage({
                type: 'addCellBefore',
                payload: {
                    currentSlideIndex: currentPayloadSlideIndex,
                    cellType: 'markdown' // Default to markdown for now
                }
            });
        } else {
            console.warn('[PreviewScript] AddCellBefore: currentPayloadSlideIndex not available.');
        }
    });
} else {
    console.warn('[PreviewScript] Add Slide Left button not found.');
}

if (addSlideRightButton) {
    addSlideRightButton.addEventListener('click', () => {
        if (typeof currentPayloadSlideIndex === 'number') {
            console.log(`[PreviewScript] Posting 'addCellAfter' current index ${currentPayloadSlideIndex}`);
            vscode.postMessage({
                type: 'addCellAfter',
                payload: {
                    currentSlideIndex: currentPayloadSlideIndex,
                    cellType: 'markdown' // Default to markdown for now
                }
            });
        } else {
            console.warn('[PreviewScript] AddCellAfter: currentPayloadSlideIndex not available.');
        }
    });
} else {
    console.warn('[PreviewScript] Add Slide Right button not found.');
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