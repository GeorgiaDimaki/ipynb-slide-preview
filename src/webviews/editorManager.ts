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
        cellType: 'code' | 'markdown';
    } | null,
    debounceTimer: undefined as number | undefined,
    
    initialize: function(vsCodeApi: VsCodeApi): void {
        vscode = vsCodeApi;
    },
    
    setTheme: function(theme: string) {
        if (this.activeEditor) {
            monaco.editor.setTheme(theme);
            console.log(`[EditorManager] Updated active editor theme to "${theme}".`);
        }
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
     * If a markdown editor is currently active, this function triggers the
     * logic to render it back to its HTML view.
     */
    renderActiveMarkdownEditor: function() {
        // Check if the active editor is for a markdown cell
        if (this.activeEditor && this.activeEditorInfo?.cellType === 'markdown') {
            console.log('[EditorManager] Rendering active markdown editor before presentation.');
            // The simplest way to render is to programmatically click the toggle/render button,
            // which already contains the necessary logic.
            const button = this.activeEditorInfo.cellContainer.parentElement?.querySelector('.markdown-toggle-edit-button');
            (button as HTMLElement)?.click();
        }
    },

    /**
     * Creates a new editor for a cell, replacing any existing one.
     */
    create: function(
        containerElement: HTMLElement,
        slideIndex: number,
        language: string,
        initialSource: string,
        theme: string
    ) {
        // First, ensure any previous editor is fully disposed of.
        this.disposeCurrent();
        
        console.log(`[EditorManager] Creating new editor for slide ${slideIndex} with language "${language}".`);
        
        const editor = monaco.editor.create(containerElement, {
            value: initialSource,
            language: language,
            theme: theme,
            readOnly: false,
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: 'on',
        });

        const cellType = language === 'markdown' ? 'markdown' : 'code';
        this.activeEditor = editor;
        this.activeEditorInfo = { slideIndex, cellContainer: containerElement.parentElement!, initialSource, cellType };

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

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            if (language === 'markdown') {
                // For markdown, "Run" means commit and switch to render view.
                const button = this.activeEditorInfo?.cellContainer.parentElement?.querySelector('.markdown-toggle-edit-button');
                (button as HTMLElement)?.click();
            } else {
                // For code, "Run" means execute the cell.
                this.commitChanges(); // Commit latest changes before running
                vscode.postMessage({ type: 'runCell', payload: { slideIndex: this.activeEditorInfo!.slideIndex } });
            }
        });

        editor.focus();
    },

    /**
     * Handles the UI toggle for markdown cells between rendered and editor views.
     */
    toggleMarkdownEdit: function(slideIndex: number, cellContainer: HTMLElement, cellData: MarkdownCell, theme:string) {
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
            this.create(editorWrapper, slideIndex, 'markdown', sourceToString(cellData.source), theme);
        }
    }
};