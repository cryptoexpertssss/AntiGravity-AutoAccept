// AntiGravity AutoAccept v1.18.18
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
];

// ─── Webview-Isolated Permission Clicker ──────────────────────────────
// Uses a Webview Guard to prevent execution on the main VS Code window.
// The agent panel runs in an isolated Chromium process (OOPIF) since
// VS Code's migration to Out-Of-Process Iframes.
function buildPermissionScript(customTexts) {
    const allTexts = [
        'run alt', 'run ', 'accept',
        'always allow', 'allow this conversation', 'allow', 'always run',
        ...(customTexts || [])
    ];

    return `
(function() {
    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};

    // ═══ DEBOUNCE / COOLDOWN ═══
    var NOW = Date.now();
    if (window._antigravity_last_click_time && (NOW - window._antigravity_last_click_time < 3000)) {
        return 'cooldown';
    }

    // ═══ FOCUS GUARD ═══
    // If the window is not focused, we should be extremely careful about actions
    // that might trigger Electron/Windows to bring this window to front.
    var isFocused = document.hasFocus();

    function isClickable(el) {
        if (!el) return false;
        if (el.getAttribute('aria-expanded') === 'true') return false;
        
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'button' || tag.includes('button') || tag.includes('btn')) return true;
        if (el.getAttribute('role') === 'button' || el.getAttribute('tabindex') === '0') return true;
        if (el.classList && el.classList.contains('cursor-pointer')) return true;
        if (typeof el.onclick === 'function') return true;
        return false;
    }

    function findClickableParent(node) {
        var el = node;
        while (el && el !== document.body && el !== document.documentElement) {
            if (isClickable(el)) return el;
            if (el.parentNode && el.parentNode.host) {
                el = el.parentNode.host;
            } else {
                el = el.parentNode;
            }
        }
        return null;
    }

    function searchTreeForText(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var res = searchTreeForText(node.shadowRoot, text);
                if (res) return res;
            }
            
            var nText = (node.textContent || '').replace(/[\\n\\r]+/g, '').replace(/\\s+/g, '').trim().toLowerCase();
            if (nText.length > 80 || nText.length < 3) continue;

            var match = false;
            var cleanT = text.replace(/\\s+/g, '').toLowerCase();
            if (nText === cleanT || nText.startsWith(cleanT)) {
                match = true;
            } else if (text === 'accept' && nText.includes(text)) {
                match = true;
            }

            if (match) {
                var target = isClickable(node) ? node : findClickableParent(node);
                if (!target && text.includes('expand')) target = node;
                
                if (target) {
                    if (target.disabled || target.getAttribute('aria-disabled') === 'true' || 
                        (target.classList && target.classList.contains('loading')) || 
                        (target.querySelector && target.querySelector('.codicon-loading'))) {
                        continue; 
                    }
                    return target;
                }
            }
        }
        return null;
    }

    for (var i = 0; i < BUTTON_TEXTS.length; i++) {
        var t = BUTTON_TEXTS[i];
        var target = searchTreeForText(document.body, t);
        if (target) {
            window._antigravity_last_click_time = Date.now();
            
            // Only scroll if we are already focused, to avoid focus stealing
            if (isFocused) {
               try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
            }

            try { target.click(); } catch(e) {}
            try {
                var evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                target.dispatchEvent(evt);
            } catch(e) {}
            return 'clicked:' + t;
        }
    }

    // Pass 2: Expand
    var expTexts = ['expand', 'requires input'];
    for (var j = 0; j < expTexts.length; j++) {
        var eTarget = searchTreeForText(document.body, expTexts[j]);
        if (eTarget) {
            window._antigravity_last_click_time = Date.now();
            if (isFocused) {
               try { eTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
            }
            try { eTarget.click(); } catch(e) {}
            return 'clicked:' + expTexts[j];
        }
    }

    return 'no-permission-button';
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

// Wider port scan: 9000-9014 + common Chromium/Node defaults
const CDP_PORTS = [9222, 9229, ...Array.from({ length: 15 }, (_, i) => 9000 + i)];

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

                // Filter for webviews or Antigravity's specific workbench pages
                const webviews = pages.filter(p => p.url && (p.url.includes('vscode-webview://') || p.url.includes('vscode-file://')));
                log(`[CDP] Port ${port}: ${pages.length} targets, ${webviews.length} potential panels`);
                if (webviews.length === 0) continue;

                // Concurrent broadcast: fire script at ALL webviews simultaneously
                const clickPromises = webviews.map(async (page) => {
                    try {
                        const result = await cdpEvaluate(page.webSocketDebuggerUrl, script);
                        const shortId = (page.id || '').substring(0, 6) || 'unknown';

                        if (result && result.startsWith('clicked:')) {
                            const targetId = page.id || page.webSocketDebuggerUrl;

                            // Per-target expand cooldown (prevents toggle loop per chat)
                            if (result.includes('expand') || result.includes('requires input')) {
                                const now = Date.now();
                                if (lastExpandTimes[targetId] && (now - lastExpandTimes[targetId] < 8000)) {
                                    return; // This specific chat is cooling down
                                }
                                lastExpandTimes[targetId] = now;
                            }

                            log(`[CDP] ✓ Thread [${shortId}] -> ${result}`);
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

    // VS Code commands — with async lock and safety timeout
    pollIntervalId = setInterval(async () => {
        if (!isEnabled || isAccepting) return;
        isAccepting = true;
        // Safety timeout: force-release lock after 3s if commands hang
        const safetyTimer = setTimeout(() => { isAccepting = false; }, 3000);
        try {
            await Promise.allSettled(
                ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
            );
        } catch (e) { /* silent */ }
        finally {
            clearTimeout(safetyTimer);
            isAccepting = false;
        }
    }, interval);

    // CDP permission polling
    cdpIntervalId = setInterval(() => {
        checkPermissionButtons();
    }, 1500);
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

    log(`[Launcher] Spawning: "${exe}"`);
    log(`[Launcher] Args: --remote-debugging-port=${port} --user-data-dir="${userData}"`);

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userData}`
    ];

    try {
        const child = cp.spawn(`"${exe}"`, args, {
            detached: true,
            stdio: 'ignore',
            shell: true // Important for Windows paths with spaces
        });

        child.on('error', (err) => {
            log(`[Launcher] Spawn error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to launch instance: ${err.message}`);
        });

        child.unref();
        vscode.window.showInformationMessage(`🚀 Launching NEW Antigravity window on port ${port}...`);
    } catch (err) {
        log(`[Launcher] Fatal spawn error: ${err.message}`);
        vscode.window.showErrorMessage(`Fatal error launching instance: ${err.message}`);
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
    log('Extension activating (v1.18.18)');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'autoAcceptV2.toggle';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('autoAcceptV2.toggle', () => {
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
        vscode.commands.registerCommand('autoAcceptV2.launchInstance', () => {
            launchNewInstance();
        })
    );

    const launcherBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    launcherBtn.command = 'autoAcceptV2.launchInstance';
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
