const { build, context } = require('esbuild');
const path = require('path');
const fs = require('fs-extra'); 
const cssPlugin = require('esbuild-css-modules-plugin');

const isProduction = process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');

async function copyStaticAssets() {
    console.log('Copying static assets...');
    try {
        const mediaDest = path.join(__dirname, 'media');
        const codiconsSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');

        // Ensure the destination directory exists
        await fs.ensureDir(mediaDest);

        // Copy Codicons CSS file
        await fs.copyFile(
            path.join(codiconsSrc, 'codicon.css'),
            path.join(mediaDest, 'codicon.css')
        );
        console.log('  - Copied codicon.css');

        // Copy Codicons Font file
        await fs.copyFile(
            path.join(codiconsSrc, 'codicon.ttf'),
            path.join(mediaDest, 'codicon.ttf')
        );
        console.log('  - Copied codicon.ttf');

        console.log('Static assets copied successfully.');
    } catch (err) {
        console.error('Error copying static assets:', err);
        throw err; // Re-throw to fail the entire build
    }
}



const monacoEditorPath = path.join(__dirname, 'node_modules/monaco-editor/esm/vs');

const webviewConfig = {
    entryPoints: ['src/webviews/preview.ts'],
    bundle: true,
    define: { global: 'window' },
    outfile: 'media/preview.bundle.js',
    platform: 'browser',
    format: 'iife', 
    sourcemap: !isProduction,
    minify: isProduction,
    external: ['vscode'],
    plugins: [cssPlugin()],
    loader: {
        '.ttf': 'file',
    },
};

const workerEntryPoints = [
    { name: 'editor.worker', path: path.join(monacoEditorPath, 'editor/editor.worker.js') },
    { name: 'json.worker', path: path.join(monacoEditorPath, 'language/json/json.worker.js') },
    { name: 'css.worker', path: path.join(monacoEditorPath, 'language/css/css.worker.js') },
    { name: 'html.worker', path: path.join(monacoEditorPath, 'language/html/html.worker.js') },
    { name: 'ts.worker', path: path.join(monacoEditorPath, 'language/typescript/ts.worker.js') },
];

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    platform: 'node',
    format: 'cjs',
    sourcemap:!isProduction,
    minify: isProduction,
    external: ['vscode']
};


async function buildAll() {
    try {
        
        await copyStaticAssets();

        // Define all build tasks
        const allTasks = [
            webviewConfig,
            extensionConfig,
            ...workerEntryPoints.map(worker => ({
                entryPoints: [worker.path],
                bundle: true,
                outfile: `media/${worker.name}.js`,
                format: 'iife',
                platform: 'browser',
                sourcemap: !isProduction,
                minify: isProduction,
            }))
        ];

        if (isWatch) {
            // --- WATCH MODE ---
            console.log("Starting esbuild in watch mode...");
            const contexts = await Promise.all(allTasks.map(task => context(task)));
            await Promise.all(contexts.map(ctx => ctx.watch()));
            console.log("Watching for changes... Press Ctrl+C to stop.");
            // Keep the process alive
            process.stdin.resume();

        } else {
            // --- SINGLE BUILD MODE ---
            console.log("Starting esbuild for a single build...");
            await Promise.all(allTasks.map(task => build(task)));
            console.log("Build complete.");
        }
    } catch (err) {
        console.error('Build failed:', err);
        if (err.errors) { console.error("Details:", err.errors); }
        process.exit(1);
    }
}

buildAll();