'use strict';

/**
 * FlowMind Web Terminal — a small HTTP server the app runs on the Homey
 * itself, serving a full-screen desktop terminal on the LAN (the same model
 * as Home Assistant add-ons that serve their own web UI). The Homey settings
 * modal on desktop is a fixed ~330px dialog, which is unusable for a chat
 * terminal; this page is the desktop answer.
 *
 * What this port really exposes: API keys and settings stay in the Homey
 * settings page, but whoever holds the token gets the full assistant. That
 * means controlling every device, building and deleting flows, and reading
 * all saved memories, over plain HTTP. Treat the token as the house key:
 *   - it travels in a header, never in a request URL (the link carries it
 *     in the #fragment, which browsers do not send);
 *   - it can be rotated from the settings page;
 *   - the Host header must look like a LAN address, which blocks DNS
 *     rebinding from public sites;
 *   - chat turns are rate-limited in app.js.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 8737;
const MAX_BODY = 512 * 1024;

// Hosts a LAN visitor actually types or gets linked to: IP literals, bare
// hostnames, and private-use suffixes (mDNS, home routers, Tailscale). A DNS
// rebinding attack needs a public domain that resolves to the Homey, and
// none of these qualify.
const LAN_HOST_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.ts.net'];

function isLanHost(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith('[')) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(raw); // IPv6 literal
  const host = raw.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^[a-z0-9-]+$/.test(host)) return true; // "localhost", "homey", …
  return LAN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

class WebTerminal {
  constructor(app) {
    this.app = app;
    this.server = null;
    this.lastError = null;
  }

  get token() {
    return this.app.homey.settings.get('webTerminalToken') || null;
  }

  ensureToken() {
    let token = this.token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      this.app.homey.settings.set('webTerminalToken', token);
    }
    return token;
  }

  /** Invalidate the current link; open terminals get a 403 on their next call. */
  rotateToken() {
    this.app.homey.settings.unset('webTerminalToken');
    return this.ensureToken();
  }

  // Header only: a token in the query string would land in request lines,
  // proxy logs and browser history.
  _checkToken(req) {
    const given = req.headers['x-flowmind-token'] || '';
    const expected = this.token || '';
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    return expected && a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  start() {
    if (this.server) return;
    this.ensureToken();
    this.lastError = null;
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        try {
          this._json(res, (err && err.statusCode) || 500, { error: err.message || String(err) });
        } catch (e) { /* socket already gone */ }
      });
    });
    server.on('error', (err) => {
      this.lastError = err.message || String(err);
      this.app.error(`[webterminal] server error: ${this.lastError}`);
      this.server = null;
    });
    server.listen(PORT, '0.0.0.0', () => {
      this.app.log(`[webterminal] listening on :${PORT}`);
    });
    this.server = server;
  }

  stop() {
    if (!this.server) return;
    try {
      this.server.close();
    } catch (err) { /* already closed */ }
    this.server = null;
  }

  _json(res, code, obj) {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (err) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  async _handle(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (!isLanHost(req.headers.host)) {
      this._json(res, 403, { error: 'Host not allowed' });
      return;
    }

    // The page is static and holds no secrets, so it is served without a
    // token; the script reads the token from the #fragment (or an old
    // ?token= link), keeps it in localStorage and sends it as a header.
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }

    if (!this._checkToken(req)) {
      this._json(res, 403, { error: 'Invalid token' });
      return;
    }

    if (req.method === 'GET' && path === '/api/config') {
      const cfg = await this.app.getConfig();
      // Only what the terminal needs — never keys or key status details.
      this._json(res, 200, {
        provider: cfg.provider,
        model: cfg.model,
        providers: (cfg.providers || []).map((p) => ({
          id: p.id, label: p.label, defaultModel: p.defaultModel, needsBaseUrl: p.needsBaseUrl,
        })),
        keysSet: cfg.keysSet,
        compatibleBaseUrl: Boolean(cfg.compatibleBaseUrl),
        homeyApi: cfg.homeyApi,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/chat') {
      const body = await this._readBody(req);
      const started = await this.app.startChat(body);
      this._json(res, 200, started);
      return;
    }

    const jobMatch = path.match(/^\/api\/chat\/([A-Za-z0-9-]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = await this.app.getChatJob({ jobId: jobMatch[1] });
      this._json(res, 200, job);
      return;
    }

    if (req.method === 'GET' && path === '/api/memories') {
      const result = await this.app.getMemories();
      this._json(res, 200, result);
      return;
    }

    this._json(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// The terminal page. Self-contained: no external assets, token from the URL,
// desktop-first layout. Strings are embedded EN/NL (this page is served by
// the app itself, outside the Homey settings i18n pipeline).
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlowMind — terminal</title>
<style>
  :root {
    --bg:#0b0e14; --card:#10141c; --border:#232b38; --text:#d6dde8; --muted:#78828f;
    --brand:#4fd484; --danger:#f47067; --amber:#e0af68;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text); font-size:17px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace;
    display:flex; flex-direction:column;
  }
  .wrap { flex:1; display:flex; flex-direction:column; width:100%;
    max-width:1200px; margin:0 auto; padding:20px 24px; min-height:0; }
  .head { display:flex; align-items:baseline; gap:12px; padding-bottom:12px;
    border-bottom:1px solid var(--border); }
  .head h1 { margin:0; font-size:19px; font-weight:600; letter-spacing:.5px; }
  .head h1::before { content:"❯ "; color:var(--brand); }
  .conn { font-size:14px; color:var(--muted); }
  .conn.ok { color:var(--brand); }
  .head .right { margin-left:auto; display:flex; gap:8px; align-items:center; font-size:14px; color:var(--muted); }
  select {
    background:var(--bg); color:var(--text); border:1px solid var(--border);
    border-radius:6px; padding:6px 9px; font-family:inherit; font-size:14px;
  }
  #chat { flex:1; overflow-y:auto; padding:16px 2px; display:flex;
    flex-direction:column; gap:12px; min-height:0; }
  .msg { line-height:1.6; white-space:pre-wrap; word-wrap:break-word; }
  .msg.user { color:var(--brand); }
  .msg.user::before { content:"❯ "; }
  .msg.system { color:var(--muted); font-size:14.5px; }
  .msg.md { white-space:normal; }
  .msg.md ul,.msg.md ol { margin:4px 0; padding-left:22px; }
  .msg.md li { margin:2px 0; }
  .msg.md code { color:var(--amber); background:rgba(255,255,255,.06);
    padding:1px 4px; border-radius:4px; font-size:15.5px; }
  .msg.md pre { background:rgba(255,255,255,.05); padding:10px; border-radius:6px;
    overflow-x:auto; margin:6px 0; }
  .msg.md pre code { background:none; padding:0; }
  .msg.md .md-gap { height:8px; }
  .msg.md .md-h { font-weight:700; margin:6px 0 2px; }
  .typing { font-style:italic; color:var(--muted); }
  .livelog { font-size:14.5px; color:var(--muted); display:flex; flex-direction:column; gap:2px; }
  .livelog .st::before { content:"› "; color:var(--brand); }
  .livelog .st.run { color:var(--text); }
  .livelog .st.err { color:var(--danger); }
  .steps { font-size:13.5px; color:var(--muted); }
  .steps details { border:1px dashed var(--border); border-radius:6px; padding:6px 10px; }
  .steps summary { cursor:pointer; }
  .composer { display:flex; gap:10px; align-items:flex-end; padding-top:12px;
    border-top:1px solid var(--border); }
  .composer .prompt { color:var(--brand); padding:10px 0; user-select:none; }
  textarea {
    flex:1; resize:none; height:46px; min-height:46px; max-height:220px;
    background:var(--bg); color:var(--text); border:1px solid var(--border);
    border-radius:6px; padding:11px; font-family:inherit; font-size:17px; overflow-y:auto;
  }
  textarea:focus { outline:1px solid var(--brand); }
  button {
    border:1px solid var(--brand); border-radius:6px; padding:10px 18px;
    background:transparent; color:var(--brand); font-family:inherit;
    font-size:16px; font-weight:600; cursor:pointer;
  }
  button:disabled { opacity:.5; cursor:default; }
  .termline { display:flex; justify-content:space-between; font-size:13.5px;
    color:var(--muted); padding-top:8px; }
  .err { color:var(--danger); }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>FlowMind</h1>
    <span id="conn" class="conn"></span>
    <div class="right">
      <label for="prov" id="aiLabel">AI:</label>
      <select id="prov"></select>
    </div>
  </div>
  <div id="chat"></div>
  <div class="composer">
    <span class="prompt">❯</span>
    <textarea id="input"></textarea>
    <button id="send">Send</button>
  </div>
  <div class="termline"><span id="status"></span><span id="timer"></span></div>
</div>
<script>
(function () {
  'use strict';
  var NL = (navigator.language || '').toLowerCase().indexOf('nl') === 0;
  var T = {
    send: NL ? 'Stuur' : 'Send',
    welcome: NL
      ? 'FlowMind web terminal. Typ je opdracht, of /help voor commando\\u2019s.'
      : 'FlowMind web terminal. Type your request, or /help for commands.',
    thinking: NL ? 'bezig\\u2026' : 'working\\u2026',
    help: NL
      ? 'Commando\\u2019s:\\n/clear \\u2014 nieuw gesprek\\n/memories \\u2014 toon wat ik onthouden heb\\n/help \\u2014 deze lijst'
      : 'Commands:\\n/clear \\u2014 new conversation\\n/memories \\u2014 show what I remember\\n/help \\u2014 this list',
    unknown: NL ? 'Onbekend commando: ' : 'Unknown command: ',
    newChat: NL ? 'Nieuw gesprek gestart.' : 'New conversation started.',
    restored: NL ? 'Vorig gesprek hersteld.' : 'Previous conversation restored.',
    memEmpty: NL ? 'Nog geen herinneringen opgeslagen.' : 'No memories saved yet.',
    actions: NL ? ' actie(s) uitgevoerd' : ' action(s) performed',
    wentWrong: NL ? 'Er ging iets mis: ' : 'Something went wrong: ',
    connLocal: NL ? 'lokaal \\u2713' : 'local \\u2713',
    connApp: NL ? 'basis \\u2014 geen flow-schrijfsleutel' : 'basic \\u2014 no flow-write key',
    noReply: NL ? '(geen antwoord)' : '(no reply)',
    badToken: NL
      ? 'Deze link werkt niet (meer). Open de terminal opnieuw via de knop in de FlowMind-instellingen.'
      : 'This link does not work (any more). Open the terminal again via the button in the FlowMind settings.',
    timeout: NL ? 'Duurde langer dan 5 minuten \\u2014 probeer opnieuw.' : 'Took longer than 5 minutes \\u2014 try again.'
  };

  // The link carries the token in the #fragment (never sent to the server);
  // links from before v0.7.0 used ?token=. Keep it, then scrub the address bar.
  var fromLink = new URLSearchParams(location.hash.slice(1)).get('token') ||
    new URLSearchParams(location.search).get('token');
  var TOKEN = '';
  if (fromLink) {
    TOKEN = fromLink;
    try { localStorage.setItem('flowmind.web.token', fromLink); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  } else {
    try { TOKEN = localStorage.getItem('flowmind.web.token') || ''; } catch (e) {}
  }
  // Pasting a fresh #token= link into this tab only changes the fragment,
  // which does not reload the page; reload so the new token is picked up.
  window.addEventListener('hashchange', function () { location.reload(); });

  var $ = function (id) { return document.getElementById(id); };
  var cfg = null;
  var sending = false;
  var messages = [];
  try { messages = JSON.parse(localStorage.getItem('flowmind.web.chat') || '[]'); } catch (e) {}
  function persist() {
    try { localStorage.setItem('flowmind.web.chat', JSON.stringify(messages.slice(-40))); } catch (e) {}
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-FlowMind-Token': TOKEN },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 403) {
        // Rotated or wrong token: drop it, so a fresh link is not shadowed.
        try { localStorage.removeItem('flowmind.web.token'); } catch (e) {}
        throw new Error(T.badToken);
      }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error(j.error || ('HTTP ' + r.status));
      });
      return r.json();
    });
  }

  // --- tiny safe Markdown renderer (same subset as the settings page) ---
  var INLINE = /\`([^\`]+)\`|\\*\\*([\\s\\S]+?)\\*\\*|__([\\s\\S]+?)__|\\*([^*\\n]+?)\\*|_([^_\\n]+?)_/g;
  function renderInline(text, parent) {
    var last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var el;
      if (m[1] != null) { el = document.createElement('code'); el.textContent = m[1]; }
      else if (m[2] != null) { el = document.createElement('strong'); el.textContent = m[2]; }
      else if (m[3] != null) { el = document.createElement('strong'); el.textContent = m[3]; }
      else if (m[4] != null) { el = document.createElement('em'); el.textContent = m[4]; }
      else { el = document.createElement('em'); el.textContent = m[5]; }
      parent.appendChild(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderMarkdown(text, container) {
    var lines = String(text == null ? '' : text).split('\\n');
    var list = null, fence = null;
    lines.forEach(function (raw) {
      var line = raw.replace(/\\s+$/, '');
      if (/^\\s*\`\`\`/.test(line)) {
        if (fence) { fence = null; return; }
        var pre = document.createElement('pre');
        fence = document.createElement('code');
        pre.appendChild(fence);
        container.appendChild(pre);
        list = null;
        return;
      }
      if (fence) { fence.textContent += (fence.textContent ? '\\n' : '') + raw; return; }
      var bullet = line.match(/^\\s*[-*\\u2022]\\s+(.*)$/);
      var numbered = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if (bullet || numbered) {
        var tag = bullet ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) {
          list = document.createElement(bullet ? 'ul' : 'ol');
          container.appendChild(list);
        }
        var li = document.createElement('li');
        renderInline(bullet ? bullet[1] : numbered[1], li);
        list.appendChild(li);
        return;
      }
      list = null;
      if (!line.trim()) {
        var gap = document.createElement('div');
        gap.className = 'md-gap';
        container.appendChild(gap);
        return;
      }
      var heading = line.match(/^\\s*#{1,6}\\s+(.*)$/);
      var div = document.createElement('div');
      if (heading) div.className = 'md-h';
      renderInline(heading ? heading[1] : line, div);
      container.appendChild(div);
    });
  }

  function addMessage(role, content) {
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'assistant') { div.classList.add('md'); renderMarkdown(content, div); }
    else div.textContent = content;
    $('chat').appendChild(div);
    $('chat').scrollTop = $('chat').scrollHeight;
    return div;
  }

  function addSteps(steps) {
    if (!steps || !steps.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'steps';
    var details = document.createElement('details');
    var summary = document.createElement('summary');
    summary.textContent = steps.length + T.actions;
    details.appendChild(summary);
    steps.forEach(function (s) {
      var line = document.createElement('div');
      var errText = s.result && s.result.error ? ' \\u26a0 ' + s.result.error : '';
      line.textContent = '\\u2022 ' + s.tool + '(' + JSON.stringify(s.input) + ')' + errText;
      details.appendChild(line);
    });
    wrap.appendChild(details);
    $('chat').appendChild(wrap);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  function updateStatus() {
    if (!cfg) return;
    var sel = $('prov');
    var p = (cfg.providers || []).filter(function (x) { return x.id === sel.value; })[0];
    var model = p ? (sel.value === cfg.provider && cfg.model ? cfg.model : p.defaultModel) : '';
    var ha = cfg.homeyApi || {};
    var mode = ha.keySet && ha.mode === 'local' ? T.connLocal : T.connApp;
    $('status').textContent = (p ? p.label : '?') + ' \\u00b7 ' + (model || '?') + ' \\u00b7 ' + mode;
    var conn = $('conn');
    conn.textContent = mode;
    conn.className = 'conn' + (ha.keySet && ha.mode === 'local' ? ' ok' : '');
  }

  function loadConfig() {
    return api('GET', '/api/config').then(function (c) {
      cfg = c;
      var sel = $('prov');
      sel.innerHTML = '';
      (c.providers || []).forEach(function (p) {
        var usable = (c.keysSet && c.keysSet[p.id]) || (p.needsBaseUrl && c.compatibleBaseUrl);
        if (!usable) return;
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
      });
      if (c.provider) sel.value = c.provider;
      // The saved provider may have no key (an old keyless Zen install);
      // never leave the picker blank, or every chat goes to that provider.
      if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
      sel.onchange = updateStatus;
      updateStatus();
    }).catch(function (e) {
      addMessage('system', T.wentWrong + e.message);
    });
  }

  // --- live steps via polling (the job carries its steps while pending) ---
  var seenSteps = 0;
  var liveLog = null;
  var pendingLines = {}; // tool -> element still showing "…"
  function showLiveSteps(steps, beforeEl) {
    if (!steps) return;
    if (!liveLog && steps.length) {
      liveLog = document.createElement('div');
      liveLog.className = 'livelog';
      if (beforeEl) $('chat').insertBefore(liveLog, beforeEl);
      else $('chat').appendChild(liveLog);
    }
    for (var i = seenSteps; i < steps.length; i++) {
      var s = steps[i];
      if (s.status === 'running') {
        var el = document.createElement('div');
        el.className = 'st run';
        el.textContent = s.tool + ' \\u2026';
        liveLog.appendChild(el);
        pendingLines[s.tool] = el;
      } else {
        var line = pendingLines[s.tool];
        if (!line) continue;
        delete pendingLines[s.tool];
        line.className = 'st ' + (s.status === 'error' ? 'err' : 'ok');
        line.textContent = s.tool + (s.status === 'error' ? ' \\u26a0 ' + (s.error || '') : ' \\u2713');
      }
    }
    seenSteps = steps.length;
    $('chat').scrollTop = $('chat').scrollHeight;
  }
  function clearLiveLog() {
    if (liveLog && liveLog.parentNode) liveLog.parentNode.removeChild(liveLog);
    liveLog = null;
    seenSteps = 0;
    pendingLines = {};
  }

  function waitForJob(jobId, typing) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + 5 * 60 * 1000;
      function poll() {
        api('GET', '/api/chat/' + jobId).then(function (job) {
          if (job.status === 'done') { resolve(job.result || {}); return; }
          if (job.status === 'error') { reject(new Error(job.error)); return; }
          if (job.status === 'unknown') { reject(new Error('job lost')); return; }
          showLiveSteps(job.steps, typing);
          if (Date.now() > deadline) { reject(new Error(T.timeout)); return; }
          setTimeout(poll, 1200);
        }).catch(function (e) {
          if (e && e.message === T.badToken) { reject(e); return; }
          if (Date.now() > deadline) { reject(new Error(T.timeout)); return; }
          setTimeout(poll, 2000);
        });
      }
      setTimeout(poll, 700);
    });
  }

  function handleCommand(cmd) {
    var c = cmd.toLowerCase();
    if (c === '/clear') {
      messages = [];
      persist();
      $('chat').innerHTML = '';
      addMessage('system', T.newChat);
      return;
    }
    if (c === '/help') { addMessage('system', T.help); return; }
    if (c === '/memories') {
      api('GET', '/api/memories').then(function (res) {
        var mem = (res && res.memories) || [];
        addMessage('system', mem.length ? mem.map(function (m) { return '\\u00b7 ' + m.text; }).join('\\n') : T.memEmpty);
      }).catch(function (e) { addMessage('system', T.wentWrong + e.message); });
      return;
    }
    addMessage('system', T.unknown + cmd);
  }

  function send() {
    if (sending) return;
    var text = $('input').value.trim();
    if (!text) return;
    if (text.charAt(0) === '/') {
      $('input').value = '';
      $('input').style.height = '46px';
      handleCommand(text);
      return;
    }
    sending = true;
    $('send').disabled = true;
    $('input').value = '';
    $('input').style.height = '46px';
    addMessage('user', text);
    messages.push({ role: 'user', content: text });
    persist();

    var typing = addMessage('assistant', '\\u2026');
    typing.classList.add('typing');
    var startedAt = Date.now();
    var ticker = setInterval(function () {
      $('timer').textContent = Math.round((Date.now() - startedAt) / 1000) + 's';
    }, 1000);
    $('timer').textContent = T.thinking;

    api('POST', '/api/chat', { messages: messages, provider: $('prov').value })
      .then(function (started) {
        if (!started || !started.jobId) throw new Error('job lost');
        return waitForJob(started.jobId, typing);
      })
      .then(function (res) {
        typing.remove();
        clearLiveLog();
        var reply = (res && res.reply) || T.noReply;
        addMessage('assistant', reply);
        addSteps(res && res.steps);
        messages.push({ role: 'assistant', content: reply });
        persist();
      })
      .catch(function (e) {
        typing.remove();
        clearLiveLog();
        addMessage('system', T.wentWrong + e.message);
        messages.pop();
        persist();
        if (!$('input').value) $('input').value = text;
      })
      .then(function () {
        clearInterval(ticker);
        $('timer').textContent = '';
        sending = false;
        $('send').disabled = false;
        $('input').focus();
      });
  }

  $('send').textContent = T.send;
  $('send').onclick = send;
  $('input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  $('input').addEventListener('input', function () {
    var el = $('input');
    el.style.height = 'auto';
    el.style.height = Math.max(46, el.scrollHeight + 2) + 'px';
  });

  loadConfig();
  if (messages.length) {
    messages.forEach(function (m) { addMessage(m.role, m.content); });
    addMessage('system', T.restored);
  } else {
    addMessage('system', T.welcome);
  }
  $('input').focus();
})();
</script>
</body>
</html>`;

module.exports = { WebTerminal, PORT };
