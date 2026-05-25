export const SETUP_UI_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Interactive Setup Widget for OpenRecord.
 *
 * This HTML is served via the MCP Apps ui:// protocol. It provides a
 * user-friendly interface for searching MyChart instances and entering
 * credentials, rather than doing it all in the chat text.
 */

export const SETUP_UI_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect MyChart</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #1a1a1a;
      --accent: #0066cc;
      --border: #e0e0e0;
      --hover: #f5f5f5;
      --error: #d32f2f;
      --success: #388e3c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1e1e1e;
        --text: #e0e0e0;
        --accent: #4da3ff;
        --border: #333333;
        --hover: #2d2d2d;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 10px 12px;
      line-height: 1.3;
    }
    .container {
      max-width: 400px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    h1 {
      font-size: 15px;
      margin: 0 0 2px 0;
      font-weight: 700;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    label {
      font-weight: 600;
      font-size: 12px;
      opacity: 0.8;
    }
    input {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
    }
    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 9px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .status {
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 6px;
      display: none;
    }
    .status.error {
      display: block;
      background: rgba(211, 47, 47, 0.1);
      color: var(--error);
      border: 1px solid rgba(211, 47, 47, 0.2);
    }
    .status.success {
      display: block;
      background: rgba(56, 142, 60, 0.1);
      color: var(--success);
      border: 1px solid rgba(56, 142, 60, 0.2);
    }
    .loader {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s ease-in-out infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .success-card {
      display: none;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      padding: 18px 12px;
      border-radius: 10px;
      background: rgba(56, 142, 60, 0.08);
      border: 1px solid rgba(56, 142, 60, 0.25);
    }
    .success-card.visible { display: flex; }
    .check-circle {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--success);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: pop 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.3);
    }
    .check-circle svg {
      width: 32px;
      height: 32px;
      stroke: #fff;
      stroke-width: 4;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 30;
      stroke-dashoffset: 30;
      animation: draw 0.4s ease-out 0.2s forwards;
    }
    .success-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--success);
      margin: 0;
    }
    .success-sub {
      font-size: 12px;
      opacity: 0.75;
      margin: 0;
      word-break: break-all;
    }
    @keyframes pop {
      0% { transform: scale(0); }
      80% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Connect to MyChart</h1>

    <div id="status" class="status"></div>

    <div id="setup-form">
      <div class="field">
        <label>Health System</label>
        <input type="text" id="hostname" placeholder="e.g. mychart.example.org">
      </div>

      <div class="field">
        <label>Username</label>
        <input type="text" id="username" placeholder="MyChart username">
      </div>

      <div class="field">
        <label>Password</label>
        <input type="password" id="password" placeholder="MyChart password">
      </div>

      <div id="2fa-section" class="field" style="display: none;">
        <label>Verification Code</label>
        <input type="text" id="2fa-code" placeholder="6-digit code" maxlength="6">
      </div>

      <div class="actions">
        <button id="submit">Connect Account</button>
      </div>
    </div>

    <div id="success-card" class="success-card">
      <div class="check-circle">
        <svg viewBox="0 0 24 24"><polyline points="5 12.5 10 17.5 19 7.5"></polyline></svg>
      </div>
      <p class="success-title">Connected!</p>
      <p class="success-sub" id="success-host"></p>
    </div>
  </div>

  <script>
    const hostnameInput = document.getElementById('hostname');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const twoFaSection = document.getElementById('2fa-section');
    const twoFaInput = document.getElementById('2fa-code');
    const submitBtn = document.getElementById('submit');
    const statusDiv = document.getElementById('status');
    const setupForm = document.getElementById('setup-form');
    const successCard = document.getElementById('success-card');
    const successHost = document.getElementById('success-host');

    let pendingId = null;

    function showSuccess(account) {
      hideStatus();
      setupForm.style.display = 'none';
      successHost.innerText = account ? 'Linked to ' + account : '';
      successCard.classList.add('visible');
    }

    function showStatus(msg, type = 'error') {
      statusDiv.innerText = msg;
      statusDiv.className = 'status ' + type;
    }

    function hideStatus() {
      statusDiv.style.display = 'none';
    }

    // ── MCP Apps JSON-RPC bridge (wire protocol per @modelcontextprotocol/ext-apps) ──
    const MCP_APP_PROTOCOL_VERSION = '2026-01-26';
    let nextRpcId = 0;
    const pendingRpc = new Map();
    let handshakeDone = null;

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;
      if (msg.id != null && pendingRpc.has(msg.id)) {
        const { resolve, reject } = pendingRpc.get(msg.id);
        pendingRpc.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'RPC error'));
        else resolve(msg.result);
      }
    });

    function rpc(method, params) {
      const id = nextRpcId++;
      return new Promise((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      });
    }

    function notify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }

    async function ensureHandshake() {
      if (!handshakeDone) {
        handshakeDone = (async () => {
          await rpc('ui/initialize', {
            appInfo: { name: 'openrecord-setup', version: '0.1.0' },
            appCapabilities: {},
            protocolVersion: MCP_APP_PROTOCOL_VERSION,
          });
          notify('ui/notifications/initialized', {});
        })();
      }
      return handshakeDone;
    }

    // Kick off the handshake immediately so the user's first click doesn't wait on it.
    ensureHandshake().then(() => {
      // Tell the host how tall we actually are so the iframe stops scrolling.
      let lastH = 0;
      let pending = 0;
      const reportSize = () => {
        const h = document.documentElement.scrollHeight;
        if (h === lastH) return;
        lastH = h;
        notify('ui/notifications/size-changed', { height: h });
      };
      const schedule = () => {
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = 0; reportSize(); });
      };
      schedule();
      new ResizeObserver(schedule).observe(document.documentElement);
    }).catch((err) => {
      showStatus('Could not connect to host: ' + (err && err.message ? err.message : err));
    });

    submitBtn.onclick = async () => {
      const hostname = hostnameInput.value;
      const username = usernameInput.value;
      const password = passwordInput.value;
      const code = twoFaInput.value;

      if (!hostname) {
        showStatus('Please enter your MyChart hostname.');
        return;
      }
      if (!username || !password) {
        showStatus('Please enter both username and password.');
        return;
      }

      hideStatus();
      submitBtn.disabled = true;
      const originalText = submitBtn.innerText;
      submitBtn.innerHTML = '<span class="loader"></span> Connecting...';

      try {
        await ensureHandshake();
        const callTool = async (name, args) => {
          const result = await rpc('tools/call', { name, arguments: args });
          if (result && result.content && Array.isArray(result.content)) {
            const textContent = result.content.find(c => c.type === 'text');
            if (textContent) {
              try {
                return JSON.parse(textContent.text);
              } catch (e) {
                return textContent.text;
              }
            }
          }
          return result;
        };

        if (pendingId) {
          // Complete 2FA
          if (!code || code.length < 6) {
            showStatus('Please enter the 6-digit verification code.');
            submitBtn.disabled = false;
            submitBtn.innerText = originalText;
            return;
          }
          const result = await callTool('complete_2fa', { pending_id: pendingId, code });
          if (result.state === 'logged_in') {
            showSuccess(result.account);
          } else if (result.state === 'invalid_2fa') {
            showStatus('Invalid verification code. Please try again.');
            pendingId = result.pending_id; // Update if refreshed
            submitBtn.disabled = false;
            submitBtn.innerText = 'Verify Code';
          } else {
            showStatus('Unexpected state: ' + result.state);
            submitBtn.disabled = false;
            submitBtn.innerText = 'Verify Code';
          }
        } else {
          // Initial Login
          const result = await callTool('setup_account', { hostname, username, password });
          
          if (result.state === 'need_2fa') {
            pendingId = result.pending_id;
            twoFaSection.style.display = 'flex';
            showStatus('Verification code sent to your registered device.', 'success');
            submitBtn.disabled = false;
            submitBtn.innerText = 'Verify Code';
          } else if (result.state === 'logged_in') {
            showSuccess(result.account || hostname);
          } else if (result.state === 'invalid_login') {
            showStatus('Invalid username or password. Please check your credentials.');
            submitBtn.disabled = false;
            submitBtn.innerText = 'Connect Account';
          } else {
            showStatus(result.message || 'Login failed. Please try again.');
            submitBtn.disabled = false;
            submitBtn.innerText = 'Connect Account';
          }
        }
      } catch (e) {
        showStatus('Error: ' + e.message);
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
      }
    };
  </script>
</body>
</html>
`;
