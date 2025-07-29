import { marked } from 'marked';

import { EditorManager } from './editorManager'; // Imports the manager
import { NotebookCell, CodeCell, SlidePayload, VsCodeApi, MessageFromExtension, MarkdownCell, Output } from './types'; // Imports shared types
import { sourceToString } from './utils'; // Imports shared utils

// Import Monaco editor core CSS if your bundler/plugin doesn't handle it automatically,
// or if you're managing CSS manually (as in Option B we discussed).
import 'monaco-editor/min/vs/editor/editor.main.css';

// Import your custom CSS files
import '../../media/styles/_base.css';
import '../../media/styles/_layout.css';
import '../../media/styles/_presentation_mode.css';
import '../../media/styles/_cell_general.css';
import '../../media/styles/_cell_toolbar.css';
import '../../media/styles/_markdown_cell.css';
import '../../media/styles/_code_cell.css';
import '../../media/styles/_code_editor.css';
import '../../media/styles/_output_items.css';
import '../../media/styles/_slide_add_controls.css';
import '../../media/styles/_main_toolbar.css';

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
const kernelNameSpan = document.getElementById('kernel-indicator-name') as HTMLSpanElement | null;
const kernelStatusContainer = document.getElementById('kernel-status-container') as HTMLDivElement | null;


let currentPayloadSlideIndex: number | undefined;
let lastReceivedPayload: SlidePayload | undefined;

if (kernelStatusContainer) {
    kernelStatusContainer.addEventListener('click', () => {
        console.log('[PreviewScript] Kernel selector clicked. Requesting kernel selection.');
        vscode.postMessage({ type: 'requestKernelSelection' });
    });
}

let hasShownShortcutOverlay = false;

window.addEventListener('message', (event: MessageEvent<MessageFromExtension>) => {
    const message = event.data;
    console.log('[PreviewScript] Received message:', message.type, message.payload);
    switch (message.type) {
        case 'update':
            if (message.payload) {
                lastReceivedPayload = message.payload;
                currentPayloadSlideIndex = message.payload.slideIndex;
                        
                if (kernelStatusContainer) {
                    if (message.payload.kernelStatus === 'busy') {
                        // When busy, show the spinner and a temporary message.
                        kernelStatusContainer.innerHTML = `
                        <span class="codicon codicon-sync spin"></span>
                        <span id="kernel-indicator-name">Connecting...</span>
                        `;
                    } else { 
                        // When idle, show the final kernel name.
                        // This also correctly handles the initial state.
                        kernelStatusContainer.innerHTML = `
                        <span id="kernel-indicator-name">${message.payload.controllerName || 'Select Kernel'}</span>
                        `;
                    }
                }
                
                renderSlide(message.payload);
                updateControls(message.payload.slideIndex, message.payload.totalSlides);
                
                // This updates the legacy span, which we can now remove as kernelStatusContainer handles it.
                // However, leaving it for now won't cause harm.
                if (kernelNameSpan && message.payload.controllerName) {
                    kernelNameSpan.textContent = message.payload.controllerName;
                }
                
                const cellContainer = document.querySelector(`.cell[data-slide-index="${message.payload.slideIndex}"]`);
                const runButton = cellContainer?.querySelector('.run-button') as HTMLButtonElement | null;
                if (runButton) {
                    runButton.disabled = false;
                }
                
                // Add/remove a class to the body based on the presentation state
                if (message.payload.isInPresentationMode) {
                    document.body.classList.add('is-presenting');
                    
                    const overlay = document.getElementById('shortcut-overlay');
                    if (overlay && !hasShownShortcutOverlay) {
                        overlay.classList.add('visible');
                        hasShownShortcutOverlay = true;
                        setTimeout(() => {
                            overlay.classList.remove('visible');
                        }, 4000); // Hide after 4 seconds
                    }
                } else {
                    document.body.classList.remove('is-presenting');
                    hasShownShortcutOverlay = false;
                }
                
                setPresentationButtonState(message.payload.isInPresentationMode ?? false);
                
            } else {
                console.warn('[PreviewScript] updateSlide message received with no payload.');
            }
            break;
        default:
            // We log a generic message because TypeScript knows this case should be unreachable.
            console.warn('[PreviewScript] Received an unknown message type from the extension.');
            break;    
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
        case 'Escape':
            // Only exit if we are currently in presentation mode
            if (document.body.classList.contains('is-presenting')) {
                vscode.postMessage({ type: 'togglePresentationMode' });
                event.preventDefault();
            }
            break;
         case 'Enter': {
            const isMac = navigator.platform.toUpperCase().includes('MAC');
            // Check if Ctrl (or Cmd on Mac) is pressed
            if (isMac ? event.metaKey : event.ctrlKey) {
                // Check if we have a valid slide index
                if (typeof currentPayloadSlideIndex === 'number') {
                    console.log(`[PreviewScript] Global Ctrl+Enter pressed, running slide ${currentPayloadSlideIndex}`);
                    vscode.postMessage({ type: 'runCell', payload: { slideIndex: currentPayloadSlideIndex } });
                    event.preventDefault(); // Prevent any default browser action
                }
            }
            break;
        }
        // Add other keys if needed, e.g., Space for next, Shift+Space for previous
        // case ' ':
        //     vscode.postMessage({ type: 'next' });
        //     event.preventDefault();
        //     break;
    }
});

function createCellToolbar(cell: NotebookCell, slideIndex: number, cellContainerElement: HTMLDivElement): { toolbar: HTMLDivElement, executionStatusDiv: HTMLDivElement | null } {
    const toolbar = document.createElement('div');
    toolbar.className = 'cell-toolbar';

    const leftActions = document.createElement('div');
    leftActions.className = 'toolbar-actions-left'; // Style this with display:flex

    const rightActions = document.createElement('div');
    rightActions.className = 'toolbar-actions-right'; // Style this with display:flex

    let executionStatusDiv: HTMLDivElement | null = null;

    // Add "Run" button for code cells (will be pushed to the left by CSS)
    if (cell.cell_type === 'code') {
        // 1. Create a container for the run button and its status
        const runContainer = document.createElement('div');
        runContainer.className = 'run-container';

        // 2. Create and add the Run button
        const runButton = document.createElement('button');
        runButton.className = 'cell-action-button run-button';
        runButton.innerHTML = `▶ <span class="run-text">Run</span>`;
        runButton.title = 'Run Cell';
        // (We will add the onclick handler in Step 3)
        runContainer.appendChild(runButton);

        // 3. Create and add the placeholder for the status
        executionStatusDiv = document.createElement('div');
        executionStatusDiv.className = 'execution-status';

        // Check if there's persistent execution data in the cell's metadata
        const executionResult = (cell.metadata as any)?.slide_show_editor?.execution;
        if (executionResult) {
            const icon = executionResult.success
                ? `<span class="icon success">✔</span>`
                : `<span class="icon error">✖</span>`;
            executionStatusDiv.innerHTML = `${icon} ${executionResult.duration}`;
        }

        // 4. Add the whole container to the toolbar
        leftActions.appendChild(runContainer);

        // 5. Assign the onclick handler now that all elements exist
        runButton.onclick = () => {
            // Find the status div and show the spinner
            if (executionStatusDiv) { // Check if the div exists
                executionStatusDiv.innerHTML = '<div class="spinner"></div>';
            }
            runButton.disabled = true;
            vscode.postMessage({ type: 'runCell', payload: { slideIndex } });
        };
    } else if (cell.cell_type === 'markdown') {
        const toggleEditButton = document.createElement('button');
        toggleEditButton.className = 'cell-action-button markdown-toggle-edit-button';
        
        toggleEditButton.title = 'Edit Markdown';
        toggleEditButton.onclick = () => {
            const body = cellContainerElement.querySelector('.markdown-cell-body');
            if (body) {
                let monacoTheme = 'vs-dark'; // Default to dark
                if (document.body.classList.contains('vscode-light')) {
                    monacoTheme = 'vs';
                } else if (document.body.classList.contains('vscode-high-contrast')) {
                    monacoTheme = 'hc-black';
                }
                EditorManager.toggleMarkdownEdit(slideIndex, cellContainerElement, cell as MarkdownCell, monacoTheme);
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
    
    return { toolbar, executionStatusDiv };
}

// This function determines the Monaco theme and applies it.
function applyCurrentTheme() {
    let monacoTheme = 'vs-dark'; // Default
    if (document.body.classList.contains('vscode-light')) {
        monacoTheme = 'vs';
    } else if (document.body.classList.contains('vscode-high-contrast')) {
        monacoTheme = 'hc-black';
    }
    EditorManager.setTheme(monacoTheme);
}

const themeObserver = new MutationObserver((mutationsList, observer) => {
    // We only care about changes to the 'class' attribute.
    for (const mutation of mutationsList) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            console.log('[PreviewScript] Body class changed, updating theme.');
            applyCurrentTheme();
            break; // No need to check other mutations
        }
    }
});


themeObserver.observe(document.body, { attributes: true });

console.log('[PreviewScript] Theme change observer is now active.');

function renderSlide(payload: SlidePayload): void {
    if (!contentDiv) { return; }
    console.log(`[PreviewScript] renderSlide called for slide ${payload.slideIndex}`);

    // If we get an update for the slide that already has an active editor,
    // we just update its content instead of doing a disruptive full re-render.
    if (EditorManager.activeEditor && EditorManager.activeEditorInfo?.slideIndex === payload.slideIndex && payload.cell && EditorManager.activeEditorInfo.cellType === payload.cell.cell_type) {
        const cellContainerDiv = EditorManager.activeEditorInfo.cellContainer.closest('.cell') as HTMLDivElement | null;
        if (!cellContainerDiv) { return; }

        console.log(`[PreviewScript] renderSlide: Performing non-destructive update for slide ${payload.slideIndex}`);

        // --- 1. Update Editor Source (if needed) ---
        const newSource = sourceToString(payload.cell.source);
        const editorModel = EditorManager.activeEditor.getModel();
        if (editorModel && editorModel.getValue() !== newSource) {
            console.log(`[PreviewScript] Applying non-destructive update to active editor's source.`);
            const fullRange = editorModel.getFullModelRange();
            editorModel.pushEditOperations([], [{ range: fullRange, text: newSource }], () => null);
            EditorManager.activeEditorInfo.initialSource = newSource;
        }

        // --- 2. Re-bind Toolbar Listeners (if needed) ---
        const oldToolbar = cellContainerDiv.querySelector('.cell-toolbar');
        if (oldToolbar) {
            // Get both the new toolbar and the new status div
            const { toolbar: newToolbar, executionStatusDiv: newExecutionStatusDiv } = createCellToolbar(payload.cell, payload.slideIndex, cellContainerDiv);
            oldToolbar.replaceWith(newToolbar);

            const cellBody = cellContainerDiv.querySelector('.code-cell-body') || cellContainerDiv.querySelector('.markdown-cell-body');
            if (cellBody) {
                // Remove the old status div if it exists
                const oldStatusDiv = cellBody.querySelector('.execution-status');
                oldStatusDiv?.remove();
                // Append the new one if it was created
                if (newExecutionStatusDiv) {
                    cellBody.appendChild(newExecutionStatusDiv);
                }
            }
        }

        const executionCountDiv = cellContainerDiv.querySelector('.execution-count');
        if (executionCountDiv && payload.cell.cell_type === 'code') {
            if (payload.cell.execution_count) {
                executionCountDiv.textContent = `[${payload.cell.execution_count}]`;
            } else {
                executionCountDiv.textContent = '[ ]';
            }
        }

        // --- 3. Render Outputs ---
        if (payload.cell.cell_type === 'code') {
            const codeCell = payload.cell as CodeCell;
            const cellBody = cellContainerDiv.querySelector('.code-cell-body');

            if (cellBody) {
                // Find or create the output wrapper
                let outputWrapperDiv = cellBody.querySelector('.cell-output-wrapper') as HTMLDivElement;
                if (!outputWrapperDiv) {
                    outputWrapperDiv = document.createElement('div');
                    outputWrapperDiv.className = 'cell-output-wrapper';
                    cellBody.appendChild(outputWrapperDiv);
                }

                // Find or create the actual output container
                let outputDiv = outputWrapperDiv.querySelector('.code-output') as HTMLDivElement;
                if (!outputDiv) {
                    outputDiv = document.createElement('div');
                    outputDiv.className = 'code-output';
                    outputWrapperDiv.appendChild(outputDiv);
                }

                // Always clear previous outputs before rendering new ones
                outputDiv.innerHTML = '';

                if (codeCell.outputs && codeCell.outputs.length > 0) {
                    // ...ensure the wrapper and output divs exist, then render into them.
                    let ensuredWrapper = outputWrapperDiv;
                    if (!ensuredWrapper) {
                        ensuredWrapper = document.createElement('div');
                        ensuredWrapper.className = 'cell-output-wrapper';
                        cellBody.appendChild(ensuredWrapper);
                    }
                    let outputDiv = ensuredWrapper.querySelector('.code-output') as HTMLDivElement;
                    if (!outputDiv) {
                        outputDiv = document.createElement('div');
                        outputDiv.className = 'code-output';
                        ensuredWrapper.appendChild(outputDiv);
                    }
                    outputDiv.innerHTML = ''; // Clear previous before rendering new
                    
                    codeCell.outputs.forEach((output: any) => renderOutput(output, outputDiv));
                } else {
                    console.log('[PreviewScript] No outputs to render or outputs are empty.');
                    if (outputWrapperDiv) {
                        outputWrapperDiv.remove();
                    }
                }
            }
        }

        // After all updates are done, remove the busy state from the cell.
        cellContainerDiv.classList.remove('is-busy');
        
        // Find the run button and re-enable it.
        const runButton = cellContainerDiv.querySelector('.run-button') as HTMLButtonElement | null;
        if (runButton) {
            runButton.disabled = false;
            // If your onclick handler changes the button's text, restore it here.
            // For example, if you used the CSS pseudo-element, no change is needed.
        }

        // After this non-destructive update, we stop.
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

    const { toolbar, executionStatusDiv } = createCellToolbar(cell, payload.slideIndex, cellContainerDiv);
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

        if (executionStatusDiv) {
            bodyDiv.appendChild(executionStatusDiv);
        }
        

        const executionCountDiv = document.createElement('div');
        executionCountDiv.className = 'execution-count';
        if (cell.execution_count) {
            executionCountDiv.textContent = `[${cell.execution_count}]`;
        } else {
            executionCountDiv.textContent = '[ ]';
        }
        bodyDiv.appendChild(executionCountDiv);

        cellContainerDiv.appendChild(bodyDiv);

        let monacoTheme = 'vs-dark'; // Default to dark
        if (document.body.classList.contains('vscode-light')) {
            monacoTheme = 'vs';
        } else if (document.body.classList.contains('vscode-high-contrast')) {
            monacoTheme = 'hc-black';
        }

        const language = (cell.metadata?.language_info?.name || payload.notebookLanguage || 'plaintext').toLowerCase();
        EditorManager.create(
            editorContainer,
            payload.slideIndex,
            language,
            sourceToString(cell.source),
            monacoTheme
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

function setupInsertControls() {
    // This function finds all four buttons and attaches the correct
    // 'addCellBefore' or 'addCellAfter' message to them.
    
    const setupButton = (id: string, action: 'addCellBefore' | 'addCellAfter', cellType: 'code' | 'markdown') => {
        const button = document.getElementById(id);
        button?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof currentPayloadSlideIndex === 'number') {
                vscode.postMessage({ type: action, payload: { currentSlideIndex: currentPayloadSlideIndex, cellType } });
            }
        });
    };

    setupButton('add-code-before', 'addCellBefore', 'code');
    setupButton('add-markdown-before', 'addCellBefore', 'markdown');
    setupButton('add-code-after', 'addCellAfter', 'code');
    setupButton('add-markdown-after', 'addCellAfter', 'markdown');
}

// Call the setup function once the DOM is ready
setupInsertControls();

// --- Initialization ---
if (contentDiv) {
    contentDiv.textContent = 'Initializing slide preview...'; // Initial placeholder
} else {
    console.error("[PreviewScript] Main contentDiv not found on initial load!");
    document.body.innerHTML = '<p style="color:red; font-size:18px;">Error: Webview content area not found. Preview cannot load.</p>';
}

console.log("[PreviewScript] Sending 'ready' message to extension host.");
vscode.postMessage({ type: 'ready' });


const clearOutputsButton = document.getElementById('clear-outputs-button');
if (clearOutputsButton) {
    clearOutputsButton.addEventListener('click', () => {
        console.log("[PreviewScript] Clear All Outputs button clicked");
        vscode.postMessage({ type: 'clearAllOutputs' });
    });
}

const runAllButton = document.getElementById('run-all-button');
if (runAllButton) {
    runAllButton.addEventListener('click', () => {
        console.log("[PreviewScript] Run All button clicked");
        vscode.postMessage({ type: 'runAll' });
    });
}

const restartKernelButton = document.getElementById('restart-kernel-button');
if (restartKernelButton) {
    restartKernelButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'restartKernel' });
    });
}

const fullscreenButton = document.getElementById('fullscreen-button');

// This function updates the button's look based on the current mode
function setPresentationButtonState(isPresenting: boolean) {
    if (!fullscreenButton) {return;}
    const icon = fullscreenButton.querySelector('.codicon');
    const text = fullscreenButton.querySelector('span:not(.codicon)');
    if (!icon || !text) {return;}

    if (isPresenting) {
        icon.className = 'codicon codicon-screen-normal';
        text.textContent = 'Exit';
    } else {
        icon.className = 'codicon codicon-screen-full';
        text.textContent = 'Present';
    }
}

// When the button is clicked, toggle the state immediately AND notify the extension
fullscreenButton?.addEventListener('click', () => {
    // Optimistically update the UI without waiting for the extension
    const icon = fullscreenButton.querySelector('.codicon');
    const isCurrentlyPresenting = icon?.classList.contains('codicon-screen-normal') ?? false;
    setPresentationButtonState(!isCurrentlyPresenting); // Toggle to the opposite state

    // Before entering presentation mode, render any active markdown editor.
    EditorManager.renderActiveMarkdownEditor();
    
    // Now, tell the extension to perform the actual action
    vscode.postMessage({ type: 'togglePresentationMode' });
});