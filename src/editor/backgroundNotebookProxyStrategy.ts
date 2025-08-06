import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';

// --- Polyfill for node-fetch ---
import fetch, { Request, Response } from 'node-fetch';
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
import { ISpecModels } from '@jupyterlab/services/lib/kernelspec/restapi';

/**
 * Implements the kernel execution strategy by launching and managing a
 * background Jupyter server process.
 */
export class BackgroundNotebookProxyStrategy implements IKernelExecutionStrategy {

    // --- Encapsulated server configuration constants ---
    private static readonly JUPYTER_PORT = 8989;
    private static readonly JUPYTER_TOKEN = 'c8deb952f41e46e2a22d708358406560';
    private static readonly JUPYTER_BASE_URL = `http://localhost:${BackgroundNotebookProxyStrategy.JUPYTER_PORT}`;

    // --- Public Properties & Events ---

    /**
     * A flag indicating if the Jupyter server and kernel session have been successfully initialized.
     */
    public isInitialized = false;

    /**
     * An event that fires when the active kernel session changes.
     */
    public readonly onKernelChanged: vscode.Event<void>;
    
    // --- Private Properties ---
    private _serverProcess: cp.ChildProcess | undefined;
    private _kernelManager: KernelManager | undefined;
    private _sessionManager: SessionManager | undefined;
    private _sessionConnection: Session.ISessionConnection | undefined;
    private _availableKernelSpecs: ISpecModels | undefined | null;
    private readonly _onKernelChanged = new vscode.EventEmitter<void>();
    
    constructor(
        private readonly documentUri: vscode.Uri,
        private readonly documentData: any,
        private initialPythonPath: string | undefined
    ) {
        this.onKernelChanged = this._onKernelChanged.event;
    }

    // =================================================================
    // Core Strategy Implementation (IKernelExecutionStrategy)
    // =================================================================

    /**
     * Initializes the strategy by finding a suitable Python environment,
     * starting a Jupyter server, and establishing a kernel session.
     */
    public async initialize(): Promise<void> {
        let pythonPathToUse: string | undefined = undefined;

        // --- PRIORITY 1: Check the saved path for this document ---
        if (this.initialPythonPath && fs.existsSync(this.initialPythonPath)) {
            console.log(`[ProxyStrategy] Found saved path: ${this.initialPythonPath}. Verifying it has ipykernel...`);
            if (await this.hasRequiredPackages(this.initialPythonPath)) {
                console.log('[ProxyStrategy] Saved path is valid. Using it.');
                pythonPathToUse = this.initialPythonPath;
            } else {
                console.log('[ProxyStrategy] Saved path is missing ipykernel. Ignoring it.');
            }
        }

        // --- PRIORITY 2 & 3: If no valid saved path, find the best alternative ---
        if (!pythonPathToUse) {
            console.log('[ProxyStrategy] No valid saved path. Searching for an alternative interpreter.');
            pythonPathToUse = await this.findBestAlternativeInterpreter();
        }

        // --- Final Check and Server Start ---
        if (!pythonPathToUse) {
            console.error('[ProxyStrategy] Initialization failed: No suitable Python interpreter could be found after all checks.');
            throw new Error("No suitable Python interpreter found.");
        }

        console.log(`[ProxyStrategy] Attempting to initialize with interpreter: ${pythonPathToUse}`);
        this.initialPythonPath = pythonPathToUse;
        await this.startServerAndSession(pythonPathToUse);
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
            return [];
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

        await future.done;
        console.log(`[ProxyStrategy] Execution finished. Returning ${outputs.length} outputs.`);
        return outputs;
    }

    /**
     * Shuts down the kernel session and gracefully terminates the background Jupyter server process.
     */
    public dispose(): Promise<void> {
        return new Promise((resolve) => {
            console.log('[ProxyStrategy] Disposing and shutting down session and server.');
            this._sessionManager?.dispose();
            this._kernelManager?.dispose();
            
            const processToKill = this._serverProcess;
            if (processToKill) {
                this._serverProcess = undefined;

                const timeout = setTimeout(() => {
                    console.warn('[ProxyStrategy] Server process did not respond to SIGINT. Sending SIGKILL.');
                    // The 'exit' listener below will still fire after SIGKILL.
                    // This is our forceful, final attempt.
                    processToKill.kill('SIGKILL');
                    resolve();
                }, 5000); // 5-second timeout before forceful kill

                processToKill.on('exit', (code, signal) => {
                    console.log(`[ProxyStrategy] Server process has exited with signal: ${signal}, code: ${code}.`);
                    clearTimeout(timeout); // Prevent the SIGKILL from being sent.
                    resolve();
                });
                
                // First, try to shut down gracefully.
                console.log('[ProxyStrategy] Sending SIGINT to server process...');
                processToKill.kill('SIGINT');

            } else {
                // If there's no process, we're already done.
                resolve();
            }
        });
    }

    // =================================================================
    // Kernel & Session Management
    // =================================================================

    /**
     * Starts or restarts the Jupyter server and establishes a new kernel session.
     * @param pythonPath The path to the Python executable to use for the server.
     */
    public async startServerAndSession(pythonPath: string): Promise<void> {
        if (this._serverProcess) {
            console.log('[ProxyStrategy] Killing existing server process before starting a new one.');
            this._serverProcess.kill();
            this._serverProcess = undefined;
        }

        try {
            // Pass the selected pythonPath to the server starter
            const settings = await this.startJupyterServer(pythonPath);
            console.log('[ProxyStrategy] Jupyter server connection settings obtained.');

            console.log('[ProxyStrategy] Fetching kernel specs directly via REST API...');
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

                const specs = await response.json();
                this._availableKernelSpecs = specs as ISpecModels;

                console.log('[ProxyStrategy] Direct fetch response:', JSON.stringify(specs, null, 2));

                if (!this._availableKernelSpecs || !this._availableKernelSpecs.kernelspecs || Object.keys(this._availableKernelSpecs.kernelspecs).length === 0) {
                    throw new Error("The Jupyter server was contacted successfully, but it reported an empty list of available kernels.");
                }
            } catch (error) {
                console.error('[ProxyStrategy] Direct fetch for kernel specs failed:', error);
                throw error;
            }

            this._kernelManager = new KernelManager({ serverSettings: settings });
            this._sessionManager = new SessionManager({
                kernelManager: this._kernelManager,
                serverSettings: settings
            });
            
            const hash = createHash('sha256').update(pythonPath).digest('hex').substring(0, 12);
            const kernelToStart = `ipynb-slideshow-${hash}`;
            console.log(`[ProxyStrategy] Will start session with deterministically named kernel: '${kernelToStart}'.`);

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
            throw error;
        }
    }

    /**
     * Restarts the currently active kernel.
     */
    public async restartKernel(): Promise<void> {
        if (!this._sessionConnection?.kernel) {
            throw new Error("Cannot restart: no active kernel.");
        }
        
        const kernelId = this._sessionConnection.kernel.id;
        console.log(`[ProxyStrategy] Restarting kernel '${kernelId}' via direct API call...`);

        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/kernels/${kernelId}/restart`;
        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;

        try {
            const response = await (globalThis as any).fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `token ${token}` }
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
            throw error;
        }
    }

    /**
     * Changes the active kernel for the current session.
     * @param newKernelName The name of the kernel to switch to.
     */
    public async switchKernelSession(newKernelName: string): Promise<void> {
        if (!this._sessionConnection) {
            throw new Error("Cannot switch kernel, there is no active session.");
        }
        
        console.log(`[ProxyStrategy] Patching session '${this._sessionConnection.id}' to use new kernel '${newKernelName}'...`);
        const oldConnection = this._sessionConnection;
        const sessionId = this._sessionConnection.id;
        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/sessions/${sessionId}`;
        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;
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
            
            const updatedSessionModel = await response.json();
            console.log('[ProxyStrategy] Session patch successful. Received updated model.');
            
            this._sessionConnection = this._sessionManager?.connectTo({ model: updatedSessionModel });
            this._sessionConnection?.kernelChanged.connect(() => this._onKernelChanged.fire());
            oldConnection.dispose();
            this._onKernelChanged.fire();

        } catch (error) {
            console.error(`[ProxyStrategy] Failed to switch kernel via PATCH.`, error);
            this._sessionConnection = oldConnection; 
            throw error;
        }
    }

    // =================================================================
    // Data Accessors
    // =================================================================
    
    /**
     * Gets the list of kernel specifications available on the server.
     * @returns The ISpecModels object, or null/undefined if unavailable.
     */
    public getAvailableKernelSpecs(): ISpecModels | undefined | null {
        return this._availableKernelSpecs;
    }

    /**
     * Gets the internal name of the active kernel (e.g., 'python3').
     * @returns The kernel name or undefined if no session is active.
     */
    public getActiveKernelName(): string | undefined {
        return this._sessionConnection?.kernel?.name;
    }

    /**
     * Gets the user-friendly display name of the active kernel (e.g., 'Python 3.11').
     * @returns The display name or undefined if no session is active.
     */
    public getActiveKernelDisplayName(): string | undefined {
        const kernelName = this.getActiveKernelName();
        if (!kernelName || !this._availableKernelSpecs?.kernelspecs) {
            return undefined;
        }
        
        const kernelInfo: any = this._availableKernelSpecs.kernelspecs[kernelName];
        if (kernelInfo?.spec?.display_name) {
            return kernelInfo.spec.display_name;
        }
        return kernelName;
    }

    // =================================================================
    // Environment & Package Management
    // =================================================================

    /**
     * Checks if a given Python environment has the required Jupyter packages.
     * @param pythonPath The absolute path to the Python executable.
     * @returns A promise that resolves to true if packages are installed, false otherwise.
     */
    public hasRequiredPackages(pythonPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            const command = `"${pythonPath}" -c "import ipykernel, jupyter_server"`;
            cp.exec(command, (error) => {
                if (error) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    /**
     * Installs packages into the specified Python environment using pip.
     * @param pythonPath The absolute path to the Python executable.
     * @param packages An array of package names to install.
     */
    public installPackages(pythonPath: string, packages: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const outputChannel = vscode.window.createOutputChannel(`Jupyter Installation (${path.basename(pythonPath)})`);
            outputChannel.show();
            outputChannel.appendLine(`Installing packages: ${packages.join(', ')}...`);

            const command = `"${pythonPath}" -m pip install ${packages.join(' ')}`;
            outputChannel.appendLine(`> ${command}\n`);

            const child = cp.exec(command);
            child.stdout?.on('data', (data) => outputChannel.append(data.toString()));
            child.stderr?.on('data', (data) => outputChannel.append(data.toString()));
            child.on('close', (code) => {
                if (code === 0) {
                    outputChannel.appendLine('\nInstallation completed successfully.');
                    resolve();
                } else {
                    outputChannel.appendLine(`\nInstallation failed with exit code ${code}.`);
                    reject(new Error(`pip install failed. See 'Jupyter Installation' output for details.`));
                }
            });
            child.on('error', (err) => {
                outputChannel.appendLine(`\nFailed to start installation process: ${err.message}`);
                reject(new Error(`Failed to start installation. See 'Jupyter Installation' output for details.`));
            });
        });
    }

    /**
     * Registers a Python environment as a discoverable Jupyter kernel.
     * @param pythonPath The absolute path to the Python executable.
     */
    public registerKernel(pythonPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const hash = createHash('sha256').update(pythonPath).digest('hex').substring(0, 12);
            const kernelName = `ipynb-slideshow-${hash}`;
            const envFolderName = path.basename(path.dirname(path.dirname(pythonPath)));
            const displayName = `Python (${envFolderName})`;
            const command = `"${pythonPath}" -m ipykernel install --user --name "${kernelName}" --display-name "${displayName}"`;
            
            console.log(`[ProxyStrategy] Registering kernel with command: ${command}`);

            cp.exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[ProxyStrategy] Kernel registration failed for ${pythonPath}`, error);
                    console.error(`[ProxyStrategy] stderr: ${stderr}`);
                    return reject(new Error(`Failed to register kernel for ${pythonPath}.`));
                }
                console.log(`[ProxyStrategy] Kernel registration successful for ${pythonPath}.`);
                console.log(`[ProxyStrategy] stdout: ${stdout}`);
                resolve();
            });
        });
    }
    
    // =================================================================
    // Private Helper Methods
    // =================================================================

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
                const processEnv = { ...process.env, ...environment.env };
                
                const command = pythonPath;
                const args = [
                    '-m', 'jupyter_server', '--no-browser',
                    `--port=${BackgroundNotebookProxyStrategy.JUPYTER_PORT}`,
                    `--ServerApp.token=${BackgroundNotebookProxyStrategy.JUPYTER_TOKEN}`,
                    `--ServerApp.password=''`
                ];

                this._serverProcess = cp.spawn(command, args, { shell: false, detached: true, env: processEnv });

                this._serverProcess.on('error', (err) => reject(err));
                
                this._serverProcess.stderr?.on('data', (data: Buffer) => {
                    const errorOutput = data.toString();
                    console.log(`[JupyterServer stderr]: ${errorOutput}`);
                    if (errorOutput.includes('No module named jupyter')) {
                        this._serverProcess?.kill();
                        reject(new Error('The selected Python environment is missing the `jupyter` package.'));
                    }
                });

                let attempts = 0;
                const maxAttempts = 50;
                const pollInterval = setInterval(async () => {
                    if (attempts++ > maxAttempts) {
                        clearInterval(pollInterval);
                        this._serverProcess?.kill();
                        return reject(new Error("Jupyter server startup timed out."));
                    }
                    try {
                        const url = `${BackgroundNotebookProxyStrategy.JUPYTER_BASE_URL}/api/status`;
                        const token = BackgroundNotebookProxyStrategy.JUPYTER_TOKEN;
                        const response = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
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
                        // Wait for server to start
                    }
                }, 500);

            } catch (error) {
                reject(error);
            }
        });
    }

    private async createSessionDirectly(settings: ServerConnection.ISettings, options: Session.ISessionOptions): Promise<Session.IModel> {
        const url = `${settings.baseUrl}api/sessions`;
        const sessionPayload = {
            path: options.path,
            type: options.type,
            name: options.name,
            kernel: options.kernel
        };

        const response = await settings.fetch(url, {
            method: 'POST',
            body: JSON.stringify(sessionPayload),
            headers: {
                'Authorization': `token ${settings.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create session directly. Status: ${response.status}, Body: ${errorText}`);
        }
        return await response.json();
    }

    private async findBestAlternativeInterpreter(): Promise<string | undefined> {
        console.log('[ProxyStrategy] Searching for a suitable Python interpreter...');
        
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('The Python extension (ms-python.python) is required to run notebooks. Please install it.');
            return undefined;
        }
        if (!pythonExtension.isActive) { 
            await pythonExtension.activate(); 
        }

        const pythonApi = pythonExtension.exports;
        const activeEnv = await pythonApi.environments.getActiveEnvironmentPath(this.documentUri);
        
        if (activeEnv?.path && fs.existsSync(activeEnv.path)) {
            console.log(`[ProxyStrategy] Checking active environment for ipykernel: ${activeEnv.path}`);
            if (await this.hasRequiredPackages(activeEnv.path)) {
                console.log('[ProxyStrategy] Found valid active environment with ipykernel.');
                return activeEnv.path;
            }
            console.log('[ProxyStrategy] Active environment is missing ipykernel.');
        }

        const environments = await pythonApi.environments.known;
        if (!environments || environments.length === 0) {
            vscode.window.showErrorMessage('No Python environments were found. Please install Python or configure an environment.');
            return undefined;
        }

        console.log(`[ProxyStrategy] No active environment. Searching all ${environments.length} environments.`);
        for (const env of environments) {
            if (env.path && fs.existsSync(env.path)) {
                if (await this.hasRequiredPackages(env.path)) {
                    console.log(`[ProxyStrategy] Found first valid, fully configured environment in list: ${env.path}`);
                    return env.path;
                }
            }
        }

        console.error('[ProxyStrategy] Could not find any valid Python executable path in the environments list.');
        return undefined;
    }
}