import { marked } from 'marked';
import * as monaco from 'monaco-editor';
import { VsCodeApi, MarkdownCell } from './types'; // Import from types.ts
import { sourceToString } from './utils'; // Import from utils.ts

class EditorManagerClass {
    // Private state for the currently active editor
    private vscode!: VsCodeApi;
    public activeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
    public activeEditorInfo: {
        slideIndex: number;
        cellContainer: HTMLElement; // The cell body element
        initialSource: string;      // The source content when the editor was created/last committed
        cellType: 'code' | 'markdown';
    } | null = null;
    private debounceTimer: number | undefined = undefined;

    /**
     * Initializes the manager with the VS Code API bridge.
     * This must be called once when the webview is loaded.
     * @param vsCodeApi The interface for posting messages to the extension host.
     */
    public initialize(vsCodeApi: VsCodeApi): void {
        this.vscode = vsCodeApi;
    }

    /**
     * Sets the Monaco theme for the currently active editor.
     * @param theme The theme name to apply (e.g., 'vs-dark', 'hc-black').
     */
    public setTheme(theme: string): void {
        if (this.activeEditor) {
            monaco.editor.setTheme(theme);
            console.log(`[EditorManager] Updated active editor theme to "${theme}".`);
        }
    }

    /**
     * Commits the changes from the active editor to the extension host if content has changed.
     */
    public commitChanges(): void {
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
        this.vscode.postMessage({
            type: 'cellContentChanged',
            payload: {
                slideIndex: this.activeEditorInfo.slideIndex,
                newSource: newSource
            }
        });

        // After committing, the new source becomes the baseline for the next edit session.
        this.activeEditorInfo.initialSource = newSource;
    }

    /**
     * Disposes of the current active editor, committing any pending changes first.
     * This must be called before creating a new editor or rendering a new slide.
     */
    public disposeCurrent(): void {
        if (!this.activeEditor) {
            return;
        }

        console.log(`[EditorManager] Disposing editor for slide ${this.activeEditorInfo?.slideIndex}.`);
        this.commitChanges(); // Commit any pending changes before disposing.

        this.activeEditor.dispose();
        this.activeEditor = null;
        this.activeEditorInfo = null;
        clearTimeout(this.debounceTimer);
    }

    /**
     * If a markdown editor is currently active, this function triggers the
     * logic to render it back to its HTML view. Useful before entering presentation mode.
     */
    public renderActiveMarkdownEditor(): void {
        // Check if the active editor is for a markdown cell
        if (this.activeEditor && this.activeEditorInfo?.cellType === 'markdown') {
            console.log('[EditorManager] Rendering active markdown editor before presentation.');
            // The simplest way to render is to programmatically click the toggle/render button,
            // which already contains the necessary logic.
            const button = this.activeEditorInfo.cellContainer.parentElement?.querySelector('.markdown-toggle-edit-button');
            (button as HTMLElement)?.click();
        }
    }

    /**
     * Creates a new Monaco editor instance for a cell, replacing any existing one.
     * @param containerElement The DOM element to host the editor.
     * @param slideIndex The index of the slide this editor belongs to.
     * @param language The language for syntax highlighting (e.g., 'python', 'markdown').
     * @param initialSource The initial text content of the editor.
     * @param theme The Monaco theme to apply.
     */
    public create(
        containerElement: HTMLElement,
        slideIndex: number,
        language: string,
        initialSource: string,
        theme: string
    ): void {
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

        // 3. Ctrl/Cmd + Enter to "Run"
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            if (language === 'markdown') {
                // For markdown, "Run" means commit and switch to render view.
                const button = this.activeEditorInfo?.cellContainer.parentElement?.querySelector('.markdown-toggle-edit-button');
                (button as HTMLElement)?.click();
            } else {
                // For code, "Run" means execute the cell.
                this.commitChanges(); // Commit latest changes before running
                this.vscode.postMessage({ type: 'runCell', payload: { slideIndex: this.activeEditorInfo!.slideIndex } });
            }
        });

        editor.focus();
    }

    /**
     * Handles the UI toggle for a markdown cell between its rendered HTML view and the editor view.
     * @param slideIndex The index of the slide being toggled.
     * @param cellContainer The container element of the entire markdown cell.
     * @param cellData The data object for the markdown cell.
     * @param theme The current VS Code theme to apply to the editor if created.
     */
    public toggleMarkdownEdit(slideIndex: number, cellContainer: HTMLElement, cellData: MarkdownCell, theme:string): void {
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
}

// Export a single instance to maintain the singleton pattern
export const EditorManager = new EditorManagerClass();