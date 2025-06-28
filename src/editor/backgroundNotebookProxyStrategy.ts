import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// --- Polyfill for node-fetch ---
// @jupyterlab/services uses fetch, which needs to be polyfilled in a Node.js environment.
import fetch, { Request, Response } from 'node-fetch';
// We keep the polyfill as a fallback, but the explicit passing is more reliable.
if (typeof (globalThis as any).fetch !== 'function') {
    (globalThis as any).fetch = fetch;
    (globalThis as any).Request = Request;
    (globalThis as any).Response = Response;
}
// --- End Polyfill ---

import { IKernelExecutionStrategy } from './executionStrategy';
import { IpynbCell, NotebookOutput, StreamOutput, ExecuteResultOutput, ErrorOutput, DisplayDataOutput } from './ipynbSlideDocument';
import { ServerConnection, SessionManager, KernelManager } from '@jupyterlab/services';
import { Session } from '@jupyterlab/services/lib/session';
import { KernelMessage } from '@jupyterlab/services/lib/kernel';

/**
 * Implements the kernel execution strategy by launching and managing a
 * background Jupyter server process.
 */
export class BackgroundNotebookProxyStrategy implements IKernelExecutionStrategy {
    // --- PRIVATE PROPERTIES ---

    /**
     * Holds the reference to the spawned Jupyter server process.
     */
    private _serverProcess: cp.ChildProcess | undefined;

    /**
     * Manages the kernels for the session manager.
     */
    private _kernelManager: KernelManager | undefined;

    /**
     * Manages the connection to the Jupyter server and kernel sessions.
     */
    private _sessionManager: SessionManager | undefined;

    /**
     * Represents the active connection to a specific notebook's kernel session.
     */
    private _sessionConnection: Session.ISessionConnection | undefined;

    // --- CONSTRUCTOR ---

    constructor(
        private readonly documentUri: vscode.Uri,
        private readonly documentData: any
    ) {}

    // --- PUBLIC METHODS (from IKernelExecutionStrategy) ---

    /**
     * Starts the Jupyter server and establishes a kernel session for the notebook.
     */
    public async initialize(): Promise<void> {
        console.log('[ProxyStrategy] Initializing...');
        try {
            const settings = await this.startJupyterServer();
            console.log('[ProxyStrategy] Jupyter server connection settings obtained.');

            this._kernelManager = new KernelManager({
                serverSettings: settings,
            });
            this._sessionManager = new SessionManager({
                kernelManager: this._kernelManager,
                serverSettings: settings
            });

            let sessionPath: string;
            let sessionName: string;

            if (this.documentUri.scheme === 'untitled') {
                sessionName = path.basename(this.documentUri.path);
                sessionPath = sessionName;
            } else {
                sessionPath = this.documentUri.fsPath;
                sessionName = path.basename(sessionPath);
            }

            console.log(`[ProxyStrategy] Creating session with name '${sessionName}' and path '${sessionPath}'`);

            const sessionOptions: Session.ISessionOptions = {
                path: sessionPath,
                type: 'notebook',
                name: sessionName,
                kernel: { name: 'python3' }
            };
            
            // Bypass startNew and create the session with a direct API call.
            console.log('[ProxyStrategy] Creating session directly via API call...');
            const sessionModel = await this.createSessionDirectly(settings, sessionOptions);

            console.log(`[ProxyStrategy] Session created with ID: ${sessionModel.id}. Connecting...`);
            // Connect to the session we just created.
            this._sessionConnection = this._sessionManager.connectTo({ model: sessionModel });
            
            if (this._sessionConnection?.kernel) {
                console.log(`[ProxyStrategy] Kernel session started successfully: ${this._sessionConnection.kernel.name}`);
                vscode.window.setStatusBarMessage(`Kernel Connected: ${this._sessionConnection.kernel.name}`, 5000);
            } else {
                throw new Error("Failed to connect to the kernel session after creating it.");
            }

        } catch (error: any) {
            console.error('[ProxyStrategy] Initialization failed:', error);
            vscode.window.showErrorMessage(`Failed to start Jupyter session. Error: ${error.message || error}`);
        }
    }

    /**
     * Sends code from a cell to the active kernel for execution.
     * @param cell The notebook cell containing the code to execute.
     * @returns A promise that resolves with an array of output objects from the kernel.
     */
    public async executeCell(cell: IpynbCell): Promise<NotebookOutput[]> {
        const kernelConnection = this._sessionConnection?.kernel;
        if (!kernelConnection) {
            vscode.window.showErrorMessage("Cannot execute cell: No active kernel session.");
            return [];
        }

        const code = Array.isArray(cell.source) ? cell.source.join('\n') : String(cell.source);
        if (!code.trim()) {
            return []; // Don't execute empty cells
        }
        
        const outputs: NotebookOutput[] = [];
        const future = kernelConnection.requestExecute({ code, store_history: true });

        future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
            const msgType = msg.header.msg_type;
            console.log(`[ProxyStrategy] Received IOPub message: ${msgType}`);
            
            switch (msgType) {
                case 'stream':
                    const streamMsg = msg.content as KernelMessage.IStreamMsg['content'];
                    outputs.push({ output_type: 'stream', name: streamMsg.name, text: [streamMsg.text] } as StreamOutput);
                    break;
                case 'execute_result':
                    const resultMsg = msg.content as KernelMessage.IExecuteResultMsg['content'];
                    outputs.push({
                        output_type: 'execute_result',
                        execution_count: resultMsg.execution_count,
                        data: resultMsg.data,
                        metadata: resultMsg.metadata
                    } as ExecuteResultOutput);
                    break;
                case 'display_data':
                    const displayMsg = msg.content as KernelMessage.IDisplayDataMsg['content'];
                     outputs.push({
                        output_type: 'display_data',
                        data: displayMsg.data,
                        metadata: displayMsg.metadata
                    } as DisplayDataOutput);
                    break;
                case 'error':
                    const errorMsg = msg.content as KernelMessage.IErrorMsg['content'];
                    outputs.push({
                        output_type: 'error',
                        ename: errorMsg.ename,
                        evalue: errorMsg.evalue,
                        traceback: errorMsg.traceback
                    } as ErrorOutput);
                    break;
            }
        };

        // Wait for the execution to complete (when the shell reply is received)
        await future.done;
        console.log(`[ProxyStrategy] Execution finished. Returning ${outputs.length} outputs.`);
        return outputs;
    }

    /**
     * Shuts down the kernel session and kills the Jupyter server process.
     */
    public dispose(): void {
        console.log('[ProxyStrategy] Disposing and shutting down session and server.');
        // Asynchronously shut down the session without waiting
        this._sessionConnection?.shutdown().catch(e => console.error("Error during session shutdown:", e));
        
        this._sessionManager?.dispose();
        this._kernelManager?.dispose();
        
        // Kill the server process
        this._serverProcess?.kill();
        console.log('[ProxyStrategy] Dispose complete.');
    }

    // --- PRIVATE HELPER METHODS ---

    /**
     * Spawns a `jupyter server` process on a fixed port with a fixed token,
     * then polls it until it's ready to accept connections.
     * @returns A promise that resolves with the server connection settings.
     */
    private startJupyterServer(): Promise<ServerConnection.ISettings> {
        return new Promise(async (resolve, reject) => {
            const port = 8989; // Use a fixed, predictable port to avoid ambiguity.
            const token = 'c8deb952f41e46e2a22d708358406560'; // Use a fixed token.
            const baseUrl = `http://localhost:${port}`;

            try {
                const command = await this.findJupyterExecutable();
                // Command the server to use our specific port and token, and disable password auth.
                const args = [
                    'server',
                    '--no-browser',
                    `--port=${port}`,
                    `--ServerApp.token=${token}`,
                    `--ServerApp.password=''`
                ];

                this._serverProcess = cp.spawn(command, args, { shell: true, detached: true });

                this._serverProcess.on('error', (err) => {
                    reject(err);
                });
                
                // Log server output for debugging, just in case.
                this._serverProcess.stderr?.on('data', (data: Buffer) => {
                     console.log(`[JupyterServer stderr]: ${data.toString()}`);
                });

                // Poll the server's status endpoint until it's ready.
                let attempts = 0;
                const maxAttempts = 50; // 25 seconds max wait
                const pollInterval = setInterval(async () => {
                    if (attempts++ > maxAttempts) {
                        clearInterval(pollInterval);
                        this._serverProcess?.kill();
                        reject(new Error("Jupyter server startup timed out."));
                        return;
                    }

                    try {
                        const response = await fetch(`${baseUrl}/api/status`, {
                            headers: { 'Authorization': `token ${token}` }
                        });

                        if (response.ok) {
                            console.log('[ProxyStrategy] Jupyter server is responsive.');
                            clearInterval(pollInterval);
                            const settings = ServerConnection.makeSettings({
                                baseUrl: baseUrl,
                                token: token,
                                // ==================== START OF CHANGE ====================
                                // Set to true to allow the library to append the token to
                                // WebSocket URLs, which is required for authentication.
                                appendToken: true,
                                // ===================== END OF CHANGE =====================
                                fetch: fetch as any
                            });
                            resolve(settings);
                        }
                    } catch (e) {
                        // This is expected while the server is starting up (e.g., ECONNREFUSED)
                        // console.log(`[ProxyStrategy] Waiting for server... attempt ${attempts}`);
                    }
                }, 500); // Poll every 500ms

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Creates a new Jupyter session by making a direct REST API call.
     * This is more reliable than using SessionManager.startNew in some environments.
     * @param settings The server connection settings.
     * @param options The desired options for the new session.
     * @returns A promise that resolves with the session model.
     */
    private async createSessionDirectly(settings: ServerConnection.ISettings, options: Session.ISessionOptions): Promise<Session.IModel> {
        const url = `${settings.baseUrl}api/sessions`;
        const sessionPayload = {
            path: options.path,
            type: options.type,
            name: options.name,
            kernel: options.kernel
        };

        const response = await settings.fetch(
            url,
            {
                method: 'POST',
                body: JSON.stringify(sessionPayload),
                headers: {
                    'Authorization': `token ${settings.token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create session directly. Status: ${response.status}, Body: ${errorText}`);
        }
        return await response.json();
    }


    /**
     * Finds the absolute path to the `jupyter` executable on the user's system.
     * @returns A promise that resolves with the executable path string.
     */
    private findJupyterExecutable(): Promise<string> {
        const command = os.platform() === 'win32' ? 'where jupyter' : 'which jupyter';
        return new Promise((resolve, reject) => {
            cp.exec(command, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Could not find 'jupyter' executable. Please ensure it's in your system's PATH. Error: ${error.message}`));
                    return;
                }
                const jupyterPath = stdout.split(os.EOL)[0].trim();
                if (!jupyterPath) {
                    reject(new Error('Jupyter executable path is empty.'));
                } else {
                    console.log(`[ProxyStrategy] Found jupyter executable at: ${jupyterPath}`);
                    resolve(jupyterPath);
                }
            });
        });
    }
}
