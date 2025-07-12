import * as vscode from 'vscode';
import * as cp from 'child_process';
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
import { ServerConnection, SessionManager, KernelManager, KernelSpecManager } from '@jupyterlab/services';
import { Session } from '@jupyterlab/services/lib/session';
import { KernelMessage } from '@jupyterlab/services/lib/kernel';
import { ISpecModel, ISpecModels } from '@jupyterlab/services/lib/kernelspec/restapi';

/**
 * Implements the kernel execution strategy by launching and managing a
 * background Jupyter server process.
 */
export class BackgroundNotebookProxyStrategy implements IKernelExecutionStrategy {

    // --- Encapsulated server configuration constants ---
    private static readonly JUPYTER_PORT = 8989;
    private static readonly JUPYTER_TOKEN = 'c8deb952f41e46e2a22d708358406560';
    private static readonly JUPYTER_BASE_URL = `http://localhost:${BackgroundNotebookProxyStrategy.JUPYTER_PORT}`;

    public isInitialized = false;
    
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

    /**
     * Holds the specifications for all available Jupyter kernels.
     */
    private _availableKernelSpecs: ISpecModels | undefined | null;


    private readonly _onKernelChanged = new vscode.EventEmitter<void>();
    public readonly onKernelChanged = this._onKernelChanged.event;
    
    
    // --- CONSTRUCTOR ---

    constructor(
        private readonly documentUri: vscode.Uri,
        private readonly documentData: any,
        private initialPythonPath: string | undefined
    ) {}

    // --- PUBLIC METHODS (from IKernelExecutionStrategy) ---

    /**
     * Starts the Jupyter server and establishes a kernel session for the notebook.
     */
    public async initialize(): Promise<void> {
        console.log('[ProxyStrategy] Initializing automatically with saved Python path.');
        // We'll create a new method for the core logic to avoid duplication
        await this.startServerAndSession();
    }
    
    private findKernelMatchingEnvironment(pythonPath: string): string | undefined {
        console.log(this._availableKernelSpecs);
        if (!this._availableKernelSpecs?.kernelspecs) {
            return undefined;
        }
        // Look through all available kernels
        for (const key in this._availableKernelSpecs.kernelspecs) {
            
            const spec = this._availableKernelSpecs.kernelspecs[key];
            const actualspce = spec?.spec as ISpecModel;
            console.log(spec);
            // Check if the kernel's executable path matches the server's pythonPath
            if (actualspce?.argv[0] === pythonPath) {
                console.log(`[ProxyStrategy] Found matching kernel spec: ${spec?.name} for python ${pythonPath}`);
                return spec?.name; // Return the kernel's internal name (e.g., 'anaconda-kernel')
            }
        }
        console.warn(`[ProxyStrategy] Could not find a kernel spec matching the python path: ${pythonPath}`);
        return undefined; // Return undefined if no direct match is found
    }

    public async startServerAndSession(): Promise<void> {
        // Clean up any old server process before starting a new one.
        if (this._serverProcess) {
            console.log('[ProxyStrategy] Killing existing server process before starting a new one.');
            this._serverProcess.kill();
            this._serverProcess = undefined;
        }

        try {

            const pythonPath = await this.findActiveInterpreterPath();
            if (!pythonPath) {
                // If no active interpreter is found at all, we must stop.
                throw new Error("No active Python interpreter found. Please select an interpreter in VS Code.");
            }

            // Pass the selected pythonPath to the server starter
            const settings = await this.startJupyterServer(pythonPath);
            console.log('[ProxyStrategy] Jupyter server connection settings obtained.');
            
            // const specManager = new KernelSpecManager({ serverSettings: settings });
            // await specManager.ready;
            // this._availableKernelSpecs = specManager.specs;
            // console.log('[ProxyStrategy] Available kernel specs fetched:', this._availableKernelSpecs?.kernelspecs);
            // if (!this._availableKernelSpecs || Object.keys(this._availableKernelSpecs.kernelspecs).length === 0) {
            //     throw new Error("The selected Python environment started a Jupyter server, but the server found no usable kernels. Please check your installation.");
            // }

            console.log('[ProxyStrategy] Fetching kernel specs directly via REST API...');

            // Manually construct the URL for the REST API endpoint
            const url = `${settings.baseUrl}api/kernelspecs`;
            console.log(url);
            try {
                // Use the global fetch to make the API call with the required authorization token
                const response = await (globalThis as any).fetch(url, {
                    headers: { 'Authorization': `token ${settings.token}` }
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch kernel specs directly. Status: ${response.status}, Body: ${errorText}`);
                }

                // Parse the JSON response from the server
                const specs = await response.json();
                this._availableKernelSpecs = specs as ISpecModels;

                console.log('[ProxyStrategy] Direct fetch response:', JSON.stringify(specs, null, 2));

                if (!this._availableKernelSpecs || !this._availableKernelSpecs.kernelspecs || Object.keys(this._availableKernelSpecs.kernelspecs).length === 0) {
                    throw new Error("The Jupyter server was contacted successfully, but it reported an empty list of available kernels.");
                }
            } catch (error) {
                console.error('[ProxyStrategy] Direct fetch for kernel specs failed:', error);
                throw error; // Re-throw to be caught by the outer try/catch
            }

            this._kernelManager = new KernelManager({ serverSettings: settings });
            this._sessionManager = new SessionManager({
                kernelManager: this._kernelManager,
                serverSettings: settings
            });
            
            const matchingKernelName = this.findKernelMatchingEnvironment(pythonPath);
            const kernelToStart = matchingKernelName || this._availableKernelSpecs?.default || 'python3';
            console.log(`[ProxyStrategy] Will start session with kernel: '${kernelToStart}'.`);

            const sessionOptions: Session.ISessionOptions = {
                path: this.documentUri.fsPath,
                type: 'notebook',
                name: path.basename(this.documentUri.fsPath),
                kernel: { name: kernelToStart }
            };
            
            console.log(`[ProxyStrategy] Creating session...`);
            const sessionModel = await this.createSessionDirectly(settings, sessionOptions);

            this._sessionConnection = this._sessionManager.connectTo({ model: sessionModel });
            this._sessionConnection.kernelChanged.connect(() => this._onKernelChanged.fire());

            if (this._sessionConnection?.kernel) {
                const kernelName = this._sessionConnection.kernel.name;
                console.log(`[ProxyStrategy] Kernel session started successfully: ${kernelName}`);
                vscode.window.setStatusBarMessage(`Kernel Connected: ${kernelName}`, 5000);
                this.isInitialized = true;
            } else {
                throw new Error("Failed to connect to the kernel session after creating it.");
            }
        } catch (error: any) {
            console.error('[ProxyStrategy] Initialization failed:', error);
            vscode.window.showErrorMessage(`Failed to start Jupyter session. Error: ${error.message || error}`);
            // We need to re-throw or handle this to notify the provider
            throw error;
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
        //this._sessionConnection?.shutdown().catch(e => console.error("Error during session shutdown:", e));
        
        this._sessionManager?.dispose();
        this._kernelManager?.dispose();
        
        // Kill the server process
        this._serverProcess?.kill('SIGINT');
        console.log('[ProxyStrategy] Dispose complete.');
    }

    // --- PRIVATE HELPER METHODS ---

    /**
     * Spawns a `jupyter server` process on a fixed port with a fixed token,
     * then polls it until it's ready to accept connections.
     * @returns A promise that resolves with the server connection settings.
     */
    private startJupyterServer(pythonPath: string): Promise<ServerConnection.ISettings> {
        return new Promise(async (resolve, reject) => {

            try {
                
                if (!pythonPath) {
                    return reject(new Error("No Python path provided to startJupyterServer."));
                }

                const pythonExtension = vscode.extensions.getExtension('ms-python.python');
                if (!pythonExtension) { throw new Error('Python extension not found'); }
                if (!pythonExtension.isActive) { await pythonExtension.activate(); }
                const pythonApi = pythonExtension.exports;

                const environment = await pythonApi.environments.resolveEnvironment(pythonPath);
                if (!environment) { throw new Error(`Could not resolve environment for ${pythonPath}`); }
                const processEnv = {
                    ...process.env, // Inherit the main process environment (including HOME)
                    ...environment.env // Let the Python-specific variables override if needed
                };
                console.log(`[ProxyStrategy] Inheriting parent process environment. HOME is: ${processEnv.HOME}`);
                console.log('[ProxyStrategy] Resolved environment variables for spawn.');
                
                const command = pythonPath;
                const args = [
                    '-m', // Execute as a module
                    'jupyter',
                    'server',
                    '--no-browser',
                    `--port=${BackgroundNotebookProxyStrategy.JUPYTER_PORT}`,
                    `--ServerApp.token=${BackgroundNotebookProxyStrategy.JUPYTER_TOKEN}`,
                    `--ServerApp.password=''`
                ];

                this._serverProcess = cp.spawn(command, args, { 
                    shell: false, 
                    detached: true,
                    env: processEnv
                });

                this._serverProcess.on('error', (err) => {
                    reject(err);
                });
                
                // Log server output for debugging, just in case.
                this._serverProcess.stderr?.on('data', (data: Buffer) => {
                    const errorOutput = data.toString();
                    console.log(`[JupyterServer stderr]: ${errorOutput}`);
                    if (errorOutput.includes('No module named jupyter')) {
                        // If we see this, we know exactly what's wrong.
                        // We can kill the process and reject the promise immediately
                        // with a user-friendly message.
                        this._serverProcess?.kill();
                        reject(new Error(
                            'The selected Python environment is missing the `jupyter` package. Please install it or select a different environment.'
                        ));
                    }
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
                        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/status`;
                        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;

                        const response = await fetch(url, {
                            headers: { 'Authorization': `token ${token}` }
                        });


                        if (response.ok) {
                            console.log('[ProxyStrategy] Jupyter server is responsive.');
                            clearInterval(pollInterval);
                            const settings = ServerConnection.makeSettings({
                                baseUrl: BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL,
                                token: BackgroundNotebookProxyStrategy.JUPYTER_TOKEN,
                                appendToken: true,
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
    public async switchKernelSession(newKernelName: string): Promise<void> {
        if (!this._sessionConnection) {
            throw new Error("Cannot switch kernel, there is no active session.");
        }
        
        console.log(`[ProxyStrategy] Patching session '${this._sessionConnection.id}' to use new kernel '${newKernelName}'...`);

        // Get the required info for the API call
        const oldConnection = this._sessionConnection;
        const sessionId = this._sessionConnection.id;
        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/sessions/${sessionId}`;
        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;
        
        // The payload for the PATCH request
        const payload = { kernel: { name: newKernelName } };

        try {
            const response = await (globalThis as any).fetch(url, {
                method: 'PATCH',
                body: JSON.stringify(payload),
                headers: {
                    'Authorization': `token ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API call to switch kernel failed. Status: ${response.status}, Body: ${errorText}`);
            }

            // The server returns the updated session model. We will use it as our source of truth.
            const updatedSessionModel = await response.json();
            console.log('[ProxyStrategy] Session patch successful. Received updated model.');

            // 1. Create a new connection object with the updated model from the server.
            this._sessionConnection = this._sessionManager?.connectTo({ model: updatedSessionModel });

            // 2. Re-attach our event listener to the new connection object for future events.
            this._sessionConnection?.kernelChanged.connect(() => this._onKernelChanged.fire());

            // 3. Dispose of the old, stale client-side connection object.
            oldConnection.dispose();

            // 4. Manually fire our onKernelChanged event to notify the provider to update the UI.
            this._onKernelChanged.fire();

        } catch (error) {
            console.error(`[ProxyStrategy] Failed to switch kernel via PATCH.`, error);
            // If the switch fails, ensure we don't leave the state inconsistent by restoring the old connection.
            this._sessionConnection = oldConnection; 
            throw error;
        }
    }

    public getAvailableKernelSpecs(): ISpecModels | undefined | null {
        return this._availableKernelSpecs;
    }

    /**
     * Finds the path to the active Python interpreter from the VS Code Python extension.
     * @returns A promise that resolves with the path string or undefined if not found.
     */
    private async findActiveInterpreterPath(): Promise<string | undefined> {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('The Python extension (ms-python.python) is not installed.');
            return undefined;
        }
        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }
        
        // Ask for the path of the active interpreter for the current notebook file
        const pythonPath = await vscode.commands.executeCommand<string>('python.interpreterPath', this.documentUri);

        if (pythonPath) {
            console.log(`[ProxyStrategy] Found active Python interpreter at: ${pythonPath}`);
            return pythonPath;
        }
        
        return undefined;
    }
    

    public getActiveKernelName(): string | undefined {
        return this._sessionConnection?.kernel?.name;
    }

    public getActiveKernelDisplayName(): string | undefined {
        // 1. Get the name of the currently running kernel (e.g., 'python3')
        const kernelName = this.getActiveKernelName();
        if (!kernelName || !this._availableKernelSpecs?.kernelspecs) {
            return undefined;
        }

        // 2. Look up the full specification object for that kernel
        //    from the list we fetched during initialization.
        // Cast to `any` to handle the raw server response structure
        const kernelInfo: any = this._availableKernelSpecs.kernelspecs[kernelName];
        
        // 3. Return the user-friendly display_name (e.g., 'Python 3.10')
        
        // Access the *nested* display_name property
        if (kernelInfo?.spec?.display_name) {
            return kernelInfo.spec.display_name;
        }

        // Fallback to the internal kernel name if display_name isn't available
        return kernelName;
    }

    public async restartKernel(): Promise<void> {
        if (!this._sessionConnection?.kernel) {
            throw new Error("Cannot restart: no active kernel.");
        }
        
        const kernelId = this._sessionConnection.kernel.id;
        console.log(`[ProxyStrategy] Restarting kernel '${kernelId}' via direct API call...`);

        // Manually construct the request details, as the library method is unreliable.
        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/kernels/${kernelId}/restart`;
        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;

        try {
            const response = await (globalThis as any).fetch(url, {
                method: 'POST',
                // A restart request has an empty body
                headers: {
                    'Authorization': `token ${token}`
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API call to restart kernel failed. Status: ${response.status}, Body: ${errorText}`);
            }

            console.log('[ProxyStrategy] Kernel restart request successful.');
            // NOTE: A successful restart should trigger the same `kernelChanged` signal 
            // that our provider already listens to, which will update the UI.
            
        } catch (error) {
            console.error('[ProxyStrategy] Failed to restart kernel.', error);
            throw error; // Re-throw so the DocumentManager can handle it.
        }
    }
}


