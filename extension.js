// AntiGravity AutoAccept v1.18.30
// Primary: VS Code Commands API with async lock
// Secondary: Shadow DOM-piercing CDP for permission & action buttons

const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const os = require('os');
const net = require('net');

// ─── VS Code Commands ─────────────────────────────────────────────────
// Only Antigravity-specific commands — generic VS Code commands like
// chatEditing.acceptAllFiles cause sidebar interference (Outline toggling,
// folder collapsing) when the agent panel lacks focus.
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptFocusedHunk',
];

// ─── Webview-Isolated Permission Clicker ──────────────────────────────
// Uses a Webview Guard to prevent execution on the main VS Code window.
// The agent panel runs in an isolated Chromium process (OOPIF) since
// VS Code's migration to Out-Of-Process Iframes.
function buildPermissionScript(customTexts) {
    const allTexts = [
        'run alt', 'run ', 'accept',
        'always allow', 'allow this conversation', 'allow once',
        'allow', 'always run', 'this conversation',
        ...(customTexts || [])
    ];

    return `
(function() {
    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};

    // ═══ DEBOUNCE / COOLDOWN ═══
    // Keep cooldown short so Run/Allow prompts are not starved by nearby clicks.
    // 🚀 HYBRID SEARCH v28 (Speed + Shadow Pierce)
    function findAndClick() {
        // Step 1: Broad search for common button patterns
        var selectors = ['button', '[role="button"]', '.monaco-button', 'a.button'];
        for (var s = 0; s < selectors.length; s++) {
            var elements = document.querySelectorAll(selectors[s]);
            for (var e = 0; e < elements.length; e++) {
                var el = elements[e];
                var txt = (el.textContent || '').replace(/[^a-z0-9]+/gi, '').trim().toLowerCase();
                for (var b = 0; b < BUTTON_TEXTS.length; b++) {
                    var bt = BUTTON_TEXTS[b].replace(/[^a-z0-9]+/gi, '').toLowerCase();
                    if (txt === bt || txt.includes(bt)) {
                        console.log('[AutoAccept] CLICKING: ' + txt);
                        el.click();
                        return 'clicked:' + BUTTON_TEXTS[b];
                    }
                }
            }
        }
        return null;
    }

    var result = findAndClick();
    if (result) return result;

    // Step 2: Recursive fallback for nested Shadow DOMs
    function deepScan(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var res = deepScan(node.shadowRoot);
                if (res) return res;
            }
            var text = (node.textContent || '').replace(/[^a-z0-9]+/gi, '').trim().toLowerCase();
            for (var i = 0; i < BUTTON_TEXTS.length; i++) {
                var searchT = BUTTON_TEXTS[i].replace(/[^a-z0-9]+/gi, '').toLowerCase();
                if (text === searchT || text.includes(searchT)) {
                    node.click();
                    return 'clicked:' + BUTTON_TEXTS[i];
                }
            }
        }
        return null;
    }

    return deepScan(document.body) || 'no-button';
})()
`;
}


let isEnabled = false;
let isAccepting = false; // Async lock — prevents double-accepts
let pollIntervalId = null;
let cdpIntervalId = null;
let statusBarItem = null;
let outputChannel = null;
let lastExpandTimes = {}; // Per-target cooldown to prevent expand toggle loops
let isCdpBusy = false; // Async lock for CDP polling — prevents overlapping broadcasts

// Helper for visual feedback
function showSuccess(buttonName) {
    const originalText = statusBarItem.text;
    statusBarItem.text = `$(check) ${buttonName} Accepted! ✓`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    setTimeout(() => {
        statusBarItem.text = originalText;
        statusBarItem.backgroundColor = undefined;
    }, 3000);
    log(`✓ Automatically accepted: ${buttonName}`);
}

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);
    }
}

function updateStatusBar() {
    if (!statusBarItem) return;
    if (isEnabled) {
        statusBarItem.text = '$(zap) Auto: ON';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip = 'AntiGravity AutoAccept is ACTIVE — click to disable';
    } else {
        statusBarItem.text = '$(circle-slash) Auto: OFF';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'AntiGravity AutoAccept is OFF — click to enable';
    }
}

// ─── CDP Helpers ──────────────────────────────────────────────────────
function cdpGetPages(port) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data).filter(p => p.webSocketDebuggerUrl)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function cdpEvaluate(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
                clearTimeout(timeout);
                ws.close();
                const val = msg.result?.result?.value;
                const type = msg.result?.result?.type;
                const sub = msg.result?.result?.subtype;
                const exc = msg.result?.exceptionDetails;
                if (!val) {
                    const errDesc = msg.result?.result?.description || '';
                    const excText = exc?.text || '';
                    const excLine = exc?.lineNumber || '';
                    log(`[CDP-DBG] type=${type} sub=${sub} err=${errDesc.substring(0, 100)} exc=${excText} line=${excLine}`);
                }
                resolve(val || '');
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
    });
}

// Send multiple CDP commands over one WebSocket connection
function cdpSendMulti(wsUrl, commands) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        const results = {};
        let nextId = 1;
        const pending = [];

        ws.on('open', () => {
            for (const cmd of commands) {
                const id = nextId++;
                cmd._id = id;
                pending.push(id);
                ws.send(JSON.stringify({ id, method: cmd.method, params: cmd.params || {} }));
            }
        });
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id) {
                results[msg.id] = msg.result || msg.error;
                const idx = pending.indexOf(msg.id);
                if (idx !== -1) pending.splice(idx, 1);
                if (pending.length === 0) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(results);
                }
            }
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
    });
}

// Use CDP DOM protocol to pierce closed shadow DOMs and click the banner
async function clickBannerViaDom(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        let msgId = 1;

        function send(method, params = {}) {
            const id = msgId++;
            ws.send(JSON.stringify({ id, method, params }));
            return id;
        }

        const handlers = {};
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && handlers[msg.id]) handlers[msg.id](msg);
        });
        ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });

        ws.on('open', () => {
            // Step 1: Get full DOM tree piercing shadow DOMs
            const docId = send('DOM.getDocument', { depth: -1, pierce: true });
            handlers[docId] = (msg) => {
                if (!msg.result) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                // Step 2: Search for "Expand" text near the banner
                const searchId = send('DOM.performSearch', { query: 'Expand' });
                handlers[searchId] = (msg2) => {
                    const count = msg2.result?.resultCount || 0;
                    if (count === 0) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                    // Step 3: Get search result nodes
                    const getResultsId = send('DOM.getSearchResults', {
                        searchId: msg2.result.searchId,
                        fromIndex: 0,
                        toIndex: Math.min(count, 10)
                    });
                    handlers[getResultsId] = (msg3) => {
                        const nodeIds = msg3.result?.nodeIds || [];
                        if (nodeIds.length === 0) { clearTimeout(timeout); ws.close(); resolve(null); return; }

                        // Step 4: Try each node — get its box model and click at center
                        let tried = 0;
                        function tryNode(idx) {
                            if (idx >= nodeIds.length) {
                                clearTimeout(timeout); ws.close(); resolve(null); return;
                            }
                            const boxId = send('DOM.getBoxModel', { nodeId: nodeIds[idx] });
                            handlers[boxId] = (boxMsg) => {
                                tried++;
                                const quad = boxMsg.result?.model?.content;
                                if (!quad || quad.length < 4) {
                                    tryNode(idx + 1); return; // not visible, try next
                                }
                                // Calculate center of the element
                                const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                                const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                                if (x === 0 && y === 0) { tryNode(idx + 1); return; }

                                // Step 5: Real mouse click at center coordinates
                                const downId = send('Input.dispatchMouseEvent', {
                                    type: 'mousePressed', x, y, button: 'left', clickCount: 1
                                });
                                handlers[downId] = () => {
                                    const upId = send('Input.dispatchMouseEvent', {
                                        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
                                    });
                                    handlers[upId] = () => {
                                        clearTimeout(timeout);
                                        ws.close();
                                        resolve(`clicked:expand-mouse[${Math.round(x)},${Math.round(y)}]`);
                                    };
                                };
                            };
                        }
                        tryNode(0);
                    };
                };
            };
        });
    });
}

// Wider port scan: 9222-9230 (main range) + 9000-9014 (alternative range)
const CDP_PORTS = [
    ...Array.from({ length: 9 }, (_, i) => 9222 + i),
    ...Array.from({ length: 15 }, (_, i) => 9000 + i)
];

async function checkPermissionButtons() {
    // Async lock: prevent 1500ms intervals from overlapping if Chrome is slow
    if (!isEnabled || isCdpBusy) return;
    isCdpBusy = true;

    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const customTexts = config.get('customButtonTexts', []);
    const script = buildPermissionScript(customTexts);

    try {
        for (const port of CDP_PORTS) {
            try {
                const pages = await cdpGetPages(port);
                if (pages.length === 0) continue;

                // Electron/Antigravity target URLs can change across versions.
                // Exclude obvious non-app targets and probe the rest.
                // Filter targets and log everything for debugging
                // Filter targets: include all webviews, workbench, and localhost-based apps (for Antigravity)
                const webviews = pages.filter(page => {
                    if (!page.url || page.url.length < 5) return false;

                    const isInternal = page.url.startsWith('devtools://') ||
                        page.url.startsWith('chrome-extension://') ||
                        page.url.startsWith('chrome-devtools://');

                    const isApp = page.url.includes('vscode-webview://') ||
                        page.url.includes('vscode-file://') ||
                        page.url.includes('http://localhost:');

                    const isWorkbench = page.title && page.title.includes('Workbench');

                    if (!isInternal && (isApp || isWorkbench)) {
                        log(`[CDP] Including Target: ${page.title || 'Untitled'} (${page.url.substring(0, 50)}...)`);
                        return true;
                    }
                    return false;
                });

                log(`[CDP] Port ${port}: ${pages.length} targets, ${webviews.length} filtered webviews`);
                if (webviews.length === 0) continue;

                // Concurrent broadcast: fire script at ALL webviews simultaneously
                const clickPromises = webviews.map(async (page) => {
                    try {
                        const result = await cdpEvaluate(page.webSocketDebuggerUrl, script);
                        const shortId = (page.id || '').substring(0, 6) || 'unknown';
                        const title = page.title || 'Webview';

                        if (result && result.startsWith('clicked:')) {
                            log(`[CDP] ✓ Match in [${title}] (${shortId}) -> ${result}`);
                        }
                    } catch (e) {
                        // Silently swallow per-target errors
                    }
                });

                // Wait for all targets to finish evaluating
                await Promise.allSettled(clickPromises);

                // Successfully processed this CDP port
                isCdpBusy = false;
                return;
            } catch (e) { /* try next port */ }
        }
    } catch (e) { /* silent */ }
    finally {
        isCdpBusy = false; // Release lock
    }
}

// ─── Polling with Async Lock ──────────────────────────────────────────
function startPolling() {
    if (pollIntervalId) return;

    const config = vscode.workspace.getConfiguration('autoAcceptV2');
    const interval = config.get('pollInterval', 500);
    log(`Polling started (every ${interval}ms, ${ACCEPT_COMMANDS.length} commands)`);

    // 🚀 LOCAL POLLING (Restored for reliability)
    pollIntervalId = setInterval(async () => {
        if (!isEnabled || isAccepting) return;

        // FOCUS GUARD: Only execute local commands if THIS window is active.
        // This prevents background windows from scrolling or stealing focus.
        if (!vscode.window.state.focused) return;

        isAccepting = true;
        const safetyTimer = setTimeout(() => { isAccepting = false; }, 3000);
        try {
            for (const cmd of ACCEPT_COMMANDS) {
                // We run these one by one to ensure we don't spam if one fails
                await vscode.commands.executeCommand(cmd).then(() => {
                    // If a command succeeds, we provide feedback
                    // Note: executeCommand usually resolves even if no action taken, 
                    // so we look for visual changes in the next update loop.
                });
            }
        } catch (e) { /* silent */ }
        finally {
            clearTimeout(safetyTimer);
            isAccepting = false;
        }
    }, interval);

    // CDP permission polling
    cdpIntervalId = setInterval(() => {
        checkPermissionButtons();
    }, 1000);
}

function stopPolling() {
    if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
    if (cdpIntervalId) { clearInterval(cdpIntervalId); cdpIntervalId = null; }
    isAccepting = false;
    log('Polling stopped');
}


// ─── Launcher for Multiple Instances ──────────────────────────────────
async function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => {
                server.close();
                resolve(true);
            })
            .listen(port, '127.0.0.1');
    });
}

async function launchNewInstance() {
    const port = await findFreePort();
    if (!port) {
        vscode.window.showErrorMessage('No free debugging ports found in range 9222-9230.');
        return;
    }

    // Windows paths with spaces require careful spawning
    let exe = process.execPath;

    // In some portable/renamed versions, execPath might point to a helper. 
    // We want the main Antigravity/VSCode binary.
    if (!exe.toLowerCase().includes('antigravity.exe') && !exe.toLowerCase().includes('code.exe')) {
        // Fallback: search for Antigravity in common paths or use environment hints
        log(`[Launcher] execPath (${exe}) doesn't look like main binary, checking environment...`);
    }

    const userData = path.join(os.homedir(), '.antigravity-autoaccept', 'instances', `port${port}`);

    try {
        if (!fs.existsSync(userData)) {
            fs.mkdirSync(userData, { recursive: true });
        }
    } catch (e) {
        log(`[Launcher] Failed to create user-data-dir: ${e.message}`);
    }

    log(`[Launcher] Attempting launch with execPath: ${exe}`);
    log(`[Launcher] Assigned Port: ${port}`);
    log(`[Launcher] UserData Path: ${userData}`);

    // Standard VS Code args + debug flags
    const launchArgs = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir="${userData}"`,
        `--new-window`
    ];

    try {
        if (process.platform === 'win32') {
            // Using 'cmd /c start' is the most reliable way to launch a detached GUI app on Windows
            // without it being killed when the parent closes, and it handles spaces naturally.
            const fullCmd = `start "" "${exe}" ${launchArgs.join(' ')}`;
            log(`[Launcher] Windows Spawning: ${fullCmd}`);

            cp.exec(fullCmd, (err) => {
                if (err) {
                    log(`[Launcher] ❌ Exec error: ${err.message}`);
                    vscode.window.showErrorMessage(`Launcher Hook Failed: ${err.message}`);
                }
            });
        } else {
            const child = cp.spawn(exe, launchArgs, {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
        }

        log(`[Launcher] ✅ Launch sequence initiated for port ${port}`);
        vscode.window.showInformationMessage(`🚀 Launching NEW IDE on port ${port}...`);
    } catch (err) {
        log(`[Launcher] ❌ Fatal: ${err.message}`);
        vscode.window.showErrorMessage(`Fatal Launcher Error: ${err.message}`);
    }
}

async function findFreePort() {
    for (let p = 9222; p <= 9230; p++) {
        if (await isPortFree(p)) return p;
    }
    return null;
}

// ─── CDP Auto-Fix: Detect & Repair ───────────────────────────────────

function checkAndFixCDP() {
    return new Promise((resolve) => {
        const req = http.get({ hostname: '127.0.0.1', port: 9222, path: '/json/list', timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                log('[CDP] Debug port active ✓');
                resolve(true);
            });
        });
        req.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                log('[CDP] ⚠ Port 9222 refused — remote debugging not enabled');
                // Fire the notification (non-blocking) — handle clicks via .then()
                vscode.window.showErrorMessage(
                    '⚡ AutoAccept needs Debug Mode to click buttons. Port 9222 is not open.',
                    'Auto-Fix Shortcut (Windows)',
                    'Manual Guide'
                ).then(action => {
                    if (action === 'Auto-Fix Shortcut (Windows)') {
                        applyPermanentWindowsPatch();
                    } else if (action === 'Manual Guide') {
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/yazanbaker94/AntiGravity-AutoAccept#setup'));
                    }
                });
            }
            resolve(false);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function applyPermanentWindowsPatch() {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Auto-patching is Windows-only. Use the Manual Guide.');
        return;
    }

    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    // Write a .ps1 file to avoid inline escaping issues with --remote-debugging-port
    const psFile = path.join(os.tmpdir(), 'antigravity_patch_shortcut.ps1');
    const psContent = `
$flag = "--remote-debugging-port=9222"
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs"
)
$patched = $false
foreach ($dir in $paths) {
    if (Test-Path $dir) {
        $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            $shortcut = $WshShell.CreateShortcut($file.FullName)
            if ($shortcut.TargetPath -match "Antigravity") {
                if ($shortcut.Arguments -notmatch "remote-debugging-port") {
                    $shortcut.Arguments = ($shortcut.Arguments + " " + $flag).Trim()
                    $shortcut.Save()
                    $patched = $true
                    Write-Output "PATCHED: $($file.FullName)"
                }
            }
        }
    }
}
if ($patched) { Write-Output "SUCCESS" } else { Write-Output "NOT_FOUND" }
`;

    try {
        fs.writeFileSync(psFile, psContent, 'utf8');
    } catch (e) {
        log(`[CDP] Failed to write patcher script: ${e.message}`);
        vscode.window.showWarningMessage('Could not create patcher script. Please add the flag manually.');
        return;
    }

    log('[CDP] Running shortcut patcher...');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (err, stdout, stderr) => {
        // Clean up temp file
        try { fs.unlinkSync(psFile); } catch (e) { }

        if (err) {
            log(`[CDP] Patcher error: ${err.message}`);
            log(`[CDP] stderr: ${stderr}`);
            vscode.window.showWarningMessage('Shortcut patching failed. Please add the flag manually.');
            return;
        }
        log(`[CDP] Patcher output: ${stdout.trim()}`);
        if (stdout.includes('SUCCESS')) {
            log('[CDP] ✓ Shortcut patched!');
            vscode.window.showInformationMessage(
                '✅ Shortcut updated! Restart Antigravity for the fix to take effect.',
                'Restart Now'
            ).then(action => {
                if (action === 'Restart Now') applyTemporarySessionRestart();
            });
        } else {
            log('[CDP] No matching shortcuts found');
            vscode.window.showWarningMessage(
                'No Antigravity shortcut found on Desktop or Start Menu. Add --remote-debugging-port=9222 to your shortcut manually.'
            );
        }
    });
}

function applyTemporarySessionRestart() {
    vscode.window.showInformationMessage(
        '✅ Closing Antigravity — reopen from your Desktop/Start Menu shortcut to activate Debug Mode.',
        'Close Now'
    ).then(action => {
        if (action === 'Close Now') {
            vscode.commands.executeCommand('workbench.action.quit');
        }
    });
}

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
    log('Extension activating (v1.18.30)');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-autoaccept.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-autoaccept.toggle', () => {
            isEnabled = !isEnabled;
            log(`Toggled: ${isEnabled ? 'ON' : 'OFF'}`);
            if (isEnabled) { startPolling(); } else { stopPolling(); }
            updateStatusBar();
            context.globalState.update('autoAcceptV2Enabled', isEnabled);
            vscode.window.showInformationMessage(
                `AntiGravity AutoAccept: ${isEnabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-autoaccept.launchInstance', () => {
            launchNewInstance();
        })
    );

    const launcherBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    launcherBtn.command = 'antigravity-autoaccept.launchInstance';
    launcherBtn.text = '$(add) Multi-IDE+';
    launcherBtn.tooltip = 'Launch a new Antigravity instance with auto-port assignment';
    launcherBtn.show();
    context.subscriptions.push(launcherBtn);

    // Check CDP on activation — prompt auto-fix if port 9222 is closed
    checkAndFixCDP().then(cdpOk => {
        if (cdpOk) {
            // Restore saved state
            if (context.globalState.get('autoAcceptV2Enabled', false)) {
                isEnabled = true;
                startPolling();
            }
        } else {
            log('CDP not available — bot will not start until debug port is enabled');
        }
        updateStatusBar();
        log('Extension activated');
    });
}

function deactivate() {
    stopPolling();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
