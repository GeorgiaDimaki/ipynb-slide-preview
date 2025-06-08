import { marked } from 'marked';
import * as monaco from 'monaco-editor';
import { VsCodeApi, MarkdownCell } from './types'; // Import from types.ts
import { sourceToString } from './utils'; // Import from utils.ts

let vscode: VsCodeApi;

export const EditorManager = {
    
    // State for the currently active editor
    activeEditor: null as monaco.editor.IStandaloneCodeEditor | null,
    activeEditorInfo: null as {
        slideIndex: number;
        cellContainer: HTMLElement; // The cell body element
        initialSource: string;      // The source content when the editor was created/last committed
    } | null,
    debounceTimer: undefined as number | undefined,
    
    initialize: function(vsCodeApi: VsCodeApi): void {
        vscode = vsCodeApi;
    },
    
    /**
     * Commits the changes from the active editor to the extension host if content has changed.
     */
    commitChanges: function() {
        if (!this.activeEditor || !this.activeEditorInfo) {
            return;
        }

        const newSource = this.activeEditor.getValue();

        // Only commit if the content has actually changed from the last known state.
        if (newSource === this.activeEditorInfo.initialSource) {
            console.log('[EditorManager] commitChanges called, but no change from initial source.');
            return;
        }
        
        // Clear any pending debounced commit because we are committing now (e.g., on blur).
        clearTimeout(this.debounceTimer);

        console.log(`[EditorManager] Committing changes for slide ${this.activeEditorInfo.slideIndex}.`);
        vscode.postMessage({
            type: 'cellContentChanged',
            payload: {
                slideIndex: this.activeEditorInfo.slideIndex,
                newSource: newSource
            }
        });

        // After committing, the new source becomes the baseline for the next edit session.
        this.activeEditorInfo.initialSource = newSource;
    },
    
    /**
     * Disposes of the current active editor, committing any pending changes first.
     * This must be called before rendering a new slide or switching editor modes.
     */
    disposeCurrent: function() {
        if (!this.activeEditor) {
            return;
        }

        console.log(`[EditorManager] Disposing editor for slide ${this.activeEditorInfo?.slideIndex}.`);
        this.commitChanges(); // Commit any pending changes before disposing.

        this.activeEditor.dispose();
        this.activeEditor = null;
        this.activeEditorInfo = null;
        clearTimeout(this.debounceTimer);
    },

    /**
     * Creates a new editor for a cell, replacing any existing one.
     */
    create: function(
        containerElement: HTMLElement,
        slideIndex: number,
        language: string,
        initialSource: string
    ) {
        // First, ensure any previous editor is fully disposed of.
        this.disposeCurrent();
        
        console.log(`[EditorManager] Creating new editor for slide ${slideIndex} with language "${language}".`);
        
        const editor = monaco.editor.create(containerElement, {
            value: initialSource,
            language: language,
            theme: 'vs-dark',
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: 'on',
        });

        this.activeEditor = editor;
        this.activeEditorInfo = { slideIndex, cellContainer: containerElement.parentElement!, initialSource };

        // --- Attach Listeners ---

        // 1. Debounced listener for content changes
        editor.onDidChangeModelContent(() => {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = window.setTimeout(() => this.commitChanges(), 750); // 750ms debounce timer
        });

        // 2. Immediate commit on focus loss
        editor.onDidBlurEditorWidget(() => {
            console.log(`[EditorManager] Editor for slide ${slideIndex} blurred.`);
            this.commitChanges();
        });

        // 3. Editor-specific keyboard shortcuts
        editor.onKeyDown(e => {
            const isMac = navigator.platform.toUpperCase().includes('MAC');
            const isUndo = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.keyCode === monaco.KeyCode.KeyZ;
            let isRedo = false;
            if (isMac) {
                // On Mac, Redo is Cmd+Shift+Z
                isRedo = e.metaKey && e.shiftKey && e.keyCode === monaco.KeyCode.KeyZ;
            } else {
                // On Windows/Linux, Redo is typically Ctrl+Y, but Ctrl+Shift+Z is also common
                isRedo = (e.ctrlKey && e.keyCode === monaco.KeyCode.KeyY) || (e.ctrlKey && e.shiftKey && e.keyCode === monaco.KeyCode.KeyZ);
            }
            const isRunOrRender = (isMac ? e.metaKey : e.ctrlKey) && e.keyCode === monaco.KeyCode.Enter;

            if (isUndo) {
                e.preventDefault(); e.stopPropagation();
                vscode.postMessage({ type: 'requestGlobalUndo' });
            } else if (isRedo) {
                e.preventDefault(); e.stopPropagation();
                vscode.postMessage({ type: 'requestGlobalRedo' });
            } else if (isRunOrRender) {
                e.preventDefault(); e.stopPropagation();
                
                if (language === 'markdown') {
                    // For markdown, "Run" means commit and switch to render view.
                    // We find the toggle button on the parent toolbar and simulate a click.
                    const button = this.activeEditorInfo?.cellContainer.parentElement?.querySelector('.markdown-toggle-edit-button');
                    (button as HTMLElement)?.click();
                } else {
                    // For code, "Run" means execute the cell.
                    this.commitChanges(); // Commit latest changes before running
                    vscode.postMessage({ type: 'runCell', payload: { slideIndex: this.activeEditorInfo!.slideIndex } });
                }
            }
        });

        editor.focus();
    },

    /**
     * Handles the UI toggle for markdown cells between rendered and editor views.
     */
    toggleMarkdownEdit: function(slideIndex: number, cellContainer: HTMLElement, cellData: MarkdownCell) {
        // If we are toggling the currently active editor, it means we want to "Render" it.
        if (this.activeEditor && this.activeEditorInfo?.slideIndex === slideIndex) {
            const finalSource = this.activeEditor.getValue();
            
            this.disposeCurrent(); // This commits changes and disposes the editor.

            const renderedView = cellContainer.querySelector('.markdown-content') as HTMLElement;
            renderedView.innerHTML = marked.parse(finalSource) as string;
            cellContainer.classList.remove('is-editing');

        } else {
            // Otherwise, we are switching to "Edit" mode.
            this.disposeCurrent(); // Clean up any other active editor first.
            
            const editorWrapper = cellContainer.querySelector('.markdown-editor-wrapper') as HTMLElement;
            if (!editorWrapper) {return;}
            
            cellContainer.classList.add('is-editing');
            this.create(editorWrapper, slideIndex, 'markdown', sourceToString(cellData.source));
        }
    }
};