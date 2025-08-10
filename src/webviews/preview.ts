/**
 * @file This is the main script for the webview frontend of the Notebook Slide Preview.
 * It is responsible for:
 * - Setting up the Monaco Editor environment.
 * - Rendering slides (both Markdown and Code).
 * - Handling all user interactions (button clicks, keyboard shortcuts).
 * - Communicating with the extension host (VS Code backend) via the `postMessage` API.
 * - Managing the lifecycle of the Monaco Editor instance via the `EditorManager`.
 */

import { marked } from 'marked';
import * as monaco from 'monaco-editor';
import { EditorManager } from './editorManager';
import { NotebookCell, CodeCell, SlidePayload, VsCodeApi, MessageFromExtension, MarkdownCell, Output } from './types';
import { sourceToString } from './utils';

// --- STYLE & MONACO IMPORTS ---
import 'monaco-editor/min/vs/editor/editor.main.css';
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

// Import language contributions for Monaco's syntax highlighting
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';


// --- MONACO ENVIRONMENT SETUP ---
/**
 * Configures how the Monaco Editor loads its web workers. These workers are
 * used for features like syntax validation, code completion, and formatting
 * for various languages, running them in a separate thread from the UI.
 */
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
            workerPath = './editor.worker.js'; // Default worker
        }
        const worker = new Worker(workerPath);
        worker.onerror = (event) => console.error(`[Worker onerror] Label: ${label}, Path: ${workerPath}, Message: ${event.message}`, event);
        worker.onmessageerror = (event) => console.error(`[Worker onmessageerror] Label: ${label}, Path: ${workerPath}`, event);
        return worker;
    }
};

// --- VSCODE API & INITIALIZATION ---
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
EditorManager.initialize(vscode);


// --- DOM ELEMENT REFERENCES ---
const contentDiv = document.getElementById('slide-content') as HTMLDivElement | null;
const prevButton = document.getElementById('prev-button') as HTMLButtonElement | null;
const nextButton = document.getElementById('next-button') as HTMLButtonElement | null;
const indicatorSpan = document.getElementById('slide-indicator') as HTMLSpanElement | null;
const kernelStatusContainer = document.getElementById('kernel-status-container') as HTMLDivElement | null;

// --- SCRIPT STATE ---
let currentPayloadSlideIndex: number | undefined;
let hasShownShortcutOverlay = false;

// --- GLOBAL EVENT LISTENERS ---

/**
 * Main message bus handler. Listens for all messages coming from the
 * extension host (e.g., slide updates, kernel status) and dispatches
 * actions accordingly.
 */
window.addEventListener('message', (event: MessageEvent<MessageFromExtension>) => {
    const message = event.data;
    switch (message.type) {
        case 'update':
            if (message.payload) {
                currentPayloadSlideIndex = message.payload.slideIndex;
                        
                if (kernelStatusContainer) {
                    if (message.payload.kernelStatus === 'busy') {
                        kernelStatusContainer.innerHTML = `<span class="codicon codicon-sync spin"></span><span id="kernel-indicator-name">Connecting...</span>`;
                    } else { 
                        kernelStatusContainer.innerHTML = `<span id="kernel-indicator-name">${message.payload.controllerName || 'Select Kernel'}</span>`;
                    }
                }
                
                renderSlide(message.payload);
                updateControls(message.payload.slideIndex, message.payload.totalSlides);
                
                const runButton = document.querySelector(`.cell[data-slide-index="${message.payload.slideIndex}"] .run-button`) as HTMLButtonElement | null;
                if (runButton) {
                    runButton.disabled = false;
                }
                
                if (message.payload.isInPresentationMode) {
                    document.body.classList.add('is-presenting');
                    const overlay = document.getElementById('shortcut-overlay');
                    if (overlay && !hasShownShortcutOverlay) {
                        overlay.classList.add('visible');
                        hasShownShortcutOverlay = true;
                        setTimeout(() => overlay.classList.remove('visible'), 4000);
                    }
                } else {
                    document.body.classList.remove('is-presenting');
                    hasShownShortcutOverlay = false;
                }
                
                const clearOutputsButton = document.getElementById('clear-outputs-button') as HTMLButtonElement | null;
                if (clearOutputsButton) {
                    clearOutputsButton.disabled = !message.payload.hasAnyOutputs;
                }

                setPresentationButtonState(message.payload.isInPresentationMode ?? false);
            }
            break;
    }
});

/**
 * Handles global keyboard shortcuts for slide navigation (Arrow Keys),
 * presentation mode (Escape), and running cells (Ctrl/Cmd + Enter).
 */
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
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.shiftKey) ){
            return;
        }
    }

    switch (event.key) {
        case 'ArrowLeft':
            console.log('[PreviewScript] ArrowLeft pressed, posting "previous"');
            vscode.postMessage({ type: 'previous' });
            event.preventDefault();
            break;
        case 'ArrowRight':
            console.log('[PreviewScript] ArrowRight pressed, posting "next"');
            vscode.postMessage({ type: 'next' });
            event.preventDefault();
            break;
        case 'Escape':
            // Only exit if we are currently in presentation mode
            if (document.body.classList.contains('is-presenting')) {
                vscode.postMessage({ type: 'togglePresentationMode' });
                event.preventDefault();
            }
            break;
         case 'Enter': {
            const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
            if ((isMac ? event.metaKey : event.ctrlKey) && typeof currentPayloadSlideIndex === 'number') {
                vscode.postMessage({ type: 'runCell', payload: { slideIndex: currentPayloadSlideIndex } });
                event.preventDefault();
            }
            break;
        }
    }
});

// --- DOM MANIPULATION & RENDER FUNCTIONS ---

/**
 * Dynamically creates the toolbar for a given cell.
 * @param cell The data for the cell.
 * @param slideIndex The index of the cell.
 * @param cellContainerElement The parent DOM element for the cell.
 * @returns An object containing the created toolbar element and a reference to the execution status div.
 */
function createCellToolbar(cell: NotebookCell, slideIndex: number, cellContainerElement: HTMLDivElement): { toolbar: HTMLDivElement, executionStatusDiv: HTMLDivElement | null } {
    const toolbar = document.createElement('div');
    toolbar.className = 'cell-toolbar';

    const leftActions = document.createElement('div');
    leftActions.className = 'toolbar-actions-left'; 
    
    const rightActions = document.createElement('div');
    rightActions.className = 'toolbar-actions-right';
    
    let executionStatusDiv: HTMLDivElement | null = null;

    if (cell.cell_type === 'code') {
        const runContainer = document.createElement('div');
        runContainer.className = 'run-container';
        const runButton = document.createElement('button');
        runButton.className = 'cell-action-button run-button';
        runButton.innerHTML = `▶ <span class="run-text">Run</span>`;
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
        runButton.dataset.tooltip = `Run Cell (${isMac ? '⌘↩' : 'Ctrl+Enter'})`;
        runContainer.appendChild(runButton);

        executionStatusDiv = document.createElement('div');
        executionStatusDiv.className = 'execution-status';
        const executionResult = (cell.metadata as any)?.slide_show_editor?.execution;
        if (executionResult) {
            const icon = executionResult.success ? `<span class="icon success">✔</span>` : `<span class="icon error">✖</span>`;
            executionStatusDiv.innerHTML = `${icon} ${executionResult.duration}`;
        }
        leftActions.appendChild(runContainer);

        runButton.onclick = () => {
            if (executionStatusDiv) {
                executionStatusDiv.innerHTML = '<div class="spinner"></div>';
            }
            runButton.disabled = true;
            vscode.postMessage({ type: 'runCell', payload: { slideIndex } });
        };
    } else if (cell.cell_type === 'markdown') {
        const toggleEditButton = document.createElement('button');
        toggleEditButton.className = 'cell-action-button markdown-toggle-edit-button';
        toggleEditButton.dataset.tooltip = 'Edit Markdown';
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
        leftActions.appendChild(toggleEditButton); 
    }

    const deleteButton = document.createElement('button');
    deleteButton.className = 'cell-action-button delete-button';
    deleteButton.dataset.tooltip = 'Delete Cell';
    deleteButton.innerHTML = `<span class="codicon codicon-trash"></span>`;
    deleteButton.onclick = () => vscode.postMessage({ type: 'requestDeleteConfirmation', payload: { slideIndex } });    
    rightActions.appendChild(deleteButton);

    // TODO: Add "More Actions" button to rightActions
    // const moreButton = document.createElement('button');
    // moreButton.className = 'cell-action-button more-button';
    // moreButton.textContent = '...';
    // rightActions.appendChild(moreButton);

    const spacer = document.createElement('div');
    spacer.style.flexGrow = '1';
    toolbar.appendChild(leftActions);
    toolbar.appendChild(spacer);
    toolbar.appendChild(rightActions);
    
    return { toolbar, executionStatusDiv };
}

/**
 * Checks the current VS Code theme on the body element and applies the
 * corresponding theme to the active Monaco editor instance.
 */
function applyCurrentTheme() {
    let monacoTheme = 'vs-dark'; // Default
    if (document.body.classList.contains('vscode-light')) {
        monacoTheme = 'vs';
    } else if (document.body.classList.contains('vscode-high-contrast')) {
        monacoTheme = 'hc-black';
    }
    EditorManager.setTheme(monacoTheme);
}


/**
 * Renders a single slide's content into the main content area.
 * It has two paths:
 * 1. Non-destructive update: If the slide being updated already has an active editor,
 * it will update the editor's content and outputs without a full re-render.
 * 2. Full re-render: If switching to a new slide, it disposes the old editor,
 * clears the content area, and builds the new slide from scratch.
 * @param payload The data payload for the slide to render.
 */
function renderSlide(payload: SlidePayload): void {
    if (!contentDiv) { return; }
    console.log(`[PreviewScript] renderSlide called for slide ${payload.slideIndex}`);

    // Path 1: Non-destructive update for an already-active editor.
    if (EditorManager.activeEditor && EditorManager.activeEditorInfo?.slideIndex === payload.slideIndex && payload.cell && EditorManager.activeEditorInfo.cellType === payload.cell.cell_type) {
        const cellContainerDiv = EditorManager.activeEditorInfo.cellContainer.closest('.cell') as HTMLDivElement | null;
        if (!cellContainerDiv) {return;}

        const newSource = sourceToString(payload.cell.source);
        const editorModel = EditorManager.activeEditor.getModel();
        if (editorModel && editorModel.getValue() !== newSource) {
            editorModel.pushEditOperations([], [{ range: editorModel.getFullModelRange(), text: newSource }], () => null);
            EditorManager.activeEditorInfo.initialSource = newSource;
        }

        const oldToolbar = cellContainerDiv.querySelector('.cell-toolbar');
        if (oldToolbar) {
            const { toolbar: newToolbar, executionStatusDiv: newExecutionStatusDiv } = createCellToolbar(payload.cell, payload.slideIndex, cellContainerDiv);
            oldToolbar.replaceWith(newToolbar);
            const cellBody = cellContainerDiv.querySelector('.code-cell-body,.markdown-cell-body');
            if (cellBody) {
                cellBody.querySelector('.execution-status')?.remove();
                newExecutionStatusDiv && cellBody.appendChild(newExecutionStatusDiv);
            }
        }

        const executionCountDiv = cellContainerDiv.querySelector('.execution-count');
        if (executionCountDiv && payload.cell.cell_type === 'code') {
            executionCountDiv.textContent = payload.cell.execution_count ? `[${payload.cell.execution_count}]` : '[ ]';
        }

        if (payload.cell.cell_type === 'code') {
            const codeCell = payload.cell as CodeCell;
            const cellBody = cellContainerDiv.querySelector('.code-cell-body');
            if (cellBody) {
                let outputWrapperDiv = cellBody.querySelector('.cell-output-wrapper') as HTMLDivElement;
                if (codeCell.outputs && codeCell.outputs.length > 0) {
                    if (!outputWrapperDiv) {
                        outputWrapperDiv = document.createElement('div');
                        outputWrapperDiv.className = 'cell-output-wrapper';
                        cellBody.appendChild(outputWrapperDiv);
                    }
                    let outputDiv = outputWrapperDiv.querySelector('.code-output') as HTMLDivElement;
                    if (!outputDiv) {
                        outputDiv = document.createElement('div');
                        outputDiv.className = 'code-output';
                        outputWrapperDiv.appendChild(outputDiv);
                    }
                    outputDiv.innerHTML = '';
                    codeCell.outputs.forEach((output: any) => renderOutput(output, outputDiv));
                } else {
                    outputWrapperDiv?.remove();
                }
            }
        }
        
        cellContainerDiv.classList.remove('is-busy');
        const runButton = cellContainerDiv.querySelector('.run-button') as HTMLButtonElement | null;
        if (runButton) {runButton.disabled = false;}
        return;
    }

    
    // Path 2: Full re-render for a new slide.
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
        renderedContentDiv.addEventListener('dblclick', () => {

            // If the body has the 'is-presenting' class, do nothing.
            if (document.body.classList.contains('is-presenting')) {
                return;
            }
            
            let monacoTheme = 'vs-dark'; // Default to dark
            if (document.body.classList.contains('vscode-light')) {
                monacoTheme = 'vs';
            } else if (document.body.classList.contains('vscode-high-contrast')) {
                monacoTheme = 'hc-black';
            }
            // This calls the same function that the "Edit" button uses
            EditorManager.toggleMarkdownEdit(payload.slideIndex, cellContainerDiv, cell, monacoTheme);
        });

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

/**
 * Renders a single Jupyter output object into a given container element.
 * It handles various output types like streams, display data (images, HTML), and errors.
 * @param output The Jupyter output object to render.
 * @param container The parent DOM element to append the rendered output to.
 */
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
            } else if (Object.keys(data).length > 0) { 
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

/**
 * Updates the bottom navigation controls (slide indicator, prev/next buttons).
 * @param currentIndex The index of the current slide.
 * @param totalSlides The total number of slides.
 */
function updateControls(currentIndex: number, totalSlides: number): void {
    if (!indicatorSpan || !prevButton || !nextButton) {return;}
    
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

/**
 * Updates the state of the fullscreen/presentation mode button.
 * @param isPresenting Whether the UI is currently in presentation mode.
 */
function setPresentationButtonState(isPresenting: boolean) {
    const fullscreenButton = document.getElementById('fullscreen-button');
    if (!fullscreenButton) {return;}
    const icon = fullscreenButton.querySelector('.codicon');
    const text = fullscreenButton.querySelector('span:not(.codicon)');
    if (!icon || !text) {return;}

    if (isPresenting) {
        icon.className = 'codicon codicon-screen-normal';
        text.textContent = 'Exit';
        fullscreenButton.dataset.tooltip = `Exit (${/Mac|iPod|iPhone|iPad/.test(navigator.userAgent) ? '⎋' : 'Esc'})`;
    } else {
        icon.className = 'codicon codicon-screen-full';
        text.textContent = 'Present';
        fullscreenButton.dataset.tooltip = 'Presentation Mode';
    }
}

/**
 * Attaches event listeners to the four "add cell" buttons.
 */
function setupInsertControls() {
    const setupButton = (id: string, action: 'addCellBefore' | 'addCellAfter', cellType: 'code' | 'markdown') => {
        document.getElementById(id)?.addEventListener('click', (e) => {
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

const fullscreenButton = document.getElementById('fullscreen-button');

// When the button is clicked, toggle the state immediately AND notify the extension
fullscreenButton?.addEventListener('click', () => {
    // Optimistically update the UI without waiting for the extension
    const icon = fullscreenButton.querySelector('.codicon');
    const isCurrentlyPresenting = icon?.classList.contains('codicon-screen-normal') ?? false;
    setPresentationButtonState(!isCurrentlyPresenting); // Toggle to the opposite state

    // Before entering presentation mode, render any active markdown editor.
    EditorManager.renderActiveMarkdownEditor();
    vscode.postMessage({ type: 'togglePresentationMode' });
});

// Set up event listeners for all toolbar buttons
document.getElementById('prev-button')?.addEventListener('click', () => vscode.postMessage({ type: 'previous' }));
document.getElementById('next-button')?.addEventListener('click', () => vscode.postMessage({ type: 'next' }));
document.getElementById('clear-outputs-button')?.addEventListener('click', () => vscode.postMessage({ type: 'clearAllOutputs' }));
document.getElementById('run-all-button')?.addEventListener('click', () => vscode.postMessage({ type: 'runAll' }));
document.getElementById('restart-kernel-button')?.addEventListener('click', () => vscode.postMessage({ type: 'restartKernel' }));


document.getElementById('undo-button')?.addEventListener('click', () => vscode.postMessage({ type: 'requestGlobalUndo' }));
document.getElementById('redo-button')?.addEventListener('click', () => vscode.postMessage({ type: 'requestGlobalRedo' }));
document.getElementById('kernel-status-container')?.addEventListener('click', () => vscode.postMessage({ type: 'requestKernelSelection' }));
// Call the setup function once the DOM is ready
setupInsertControls();

// --- Tooltip Logic ---
const tooltip = document.getElementById('custom-tooltip-wrapper') as HTMLDivElement;
let tooltipHideTimeout: number;
window.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement;
    const tooltipTarget = target.closest('[data-tooltip]');
    if (!tooltipTarget || !tooltip) {return;}
    
    const tooltipText = tooltipTarget.getAttribute('data-tooltip');
    tooltip.textContent = tooltipText;

    const targetRect = tooltipTarget.getBoundingClientRect();
    tooltip.style.display = 'block';
    const tooltipRect = tooltip.getBoundingClientRect();
    tooltip.style.display = '';

    const top = targetRect.bottom + 8;
    let left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);

    if (left < 5) {left = 5;}
    if (left + tooltipRect.width > window.innerWidth) {left = window.innerWidth - tooltipRect.width - 5;}

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    
    clearTimeout(tooltipHideTimeout);
    tooltip.classList.add('visible');
});

window.addEventListener('mouseout', (event) => {
    const target = event.target as HTMLElement;
    const tooltipTarget = target.closest('[data-tooltip]');
    if (tooltipTarget && tooltip) {
        tooltipHideTimeout = window.setTimeout(() => tooltip.classList.remove('visible'), 100);
    }
});

// --- INITIAL LOAD ---
if (contentDiv) {
    contentDiv.textContent = 'Initializing slide preview...';
} else {
    document.body.innerHTML = '<p style="color:red; font-size:18px;">Error: Webview content area not found.</p>';
}

// Signal to the extension host that the webview is ready to receive data.
vscode.postMessage({ type: 'ready' });