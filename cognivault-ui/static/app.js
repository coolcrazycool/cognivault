/* CogniVault UI — app.js
 * Vanilla ES2020, no modules/build, no external deps. Same-origin /api/* only.
 * Sections: state · dom · utils · api · sse parser · markdown · toasts ·
 *           status · theme · settings · upload · env · chat · history · init
 */
(function () {
  "use strict";

  /* ============================ STATE ============================ */
  const state = {
    config: null,          // full config object from GET /api/config
    chatId: null,          // current conversation id (null = fresh)
    messages: [],          // visible turns: { role, content, sources?, rag? }
    rag: true,             // RAG toggle
    streaming: false,      // a chat request is in flight
    abort: null,           // AbortController for current chat stream
    tokenVisible: false,   // masked token field state
    pipTokenVisible: false, // masked SberOSC token field state
    loginTokenVisible: false, // masked login-modal token field state
  };

  /* ============================ DOM ============================ */
  const $ = (id) => document.getElementById(id);
  const dom = {
    // header / status
    pillCogni: $("pill-cognivault"),
    pillCert: $("pill-cert"),
    pillEnv: $("pill-env"),
    themeBtn: $("theme-btn"),
    settingsBtn: $("settings-btn"),
    // identity (server mode)
    identity: $("identity"),
    identityUser: $("identity-user"),
    logoutBtn: $("logout-btn"),
    // rail
    newchatBtn: $("newchat-btn"),
    chatlist: $("chatlist"),
    historyCount: $("history-count"),
    // banner
    banner: $("setup-banner"),
    bannerText: $("setup-banner-text"),
    bannerBtn: $("setup-banner-btn"),
    // chat
    stream: $("stream"),
    thread: $("thread"),
    ragSwitch: $("rag-switch"),
    ragSublabel: $("rag-sublabel"),
    input: $("composer-input"),
    sendBtn: $("send-btn"),
    // drawer
    scrim: $("scrim"),
    drawer: $("drawer"),
    drawerClose: $("drawer-close"),
    // settings §1
    cfgCognivaultUrl: $("cfg-cognivault-url"),
    cfgToken: $("cfg-token"),
    tokenToggle: $("token-toggle"),
    saveConn: $("save-conn"),
    savedConn: $("saved-conn"),
    // settings §2
    cfgGigaUrl: $("cfg-giga-url"),
    cfgModel: $("cfg-model"),
    cfgCert: $("cfg-cert"),
    cfgKey: $("cfg-key"),
    cfgPassphrase: $("cfg-passphrase"),
    cfgCa: $("cfg-ca"),
    cfgVerifySsl: $("cfg-verify-ssl"),
    saveCert: $("save-cert"),
    savedCert: $("saved-cert"),
    // §3 upload
    dropzone: $("dropzone"),
    fileInput: $("file-input"),
    uploadResult: $("upload-result"),
    uploadFilelist: $("upload-filelist"),
    uploadFiles: $("upload-files"),
    // §4 env
    cfgPipIndex: $("cfg-pip-index"),
    cfgPipToken: $("cfg-pip-token"),
    pipTokenToggle: $("pip-token-toggle"),
    saveEnvMirror: $("save-env-mirror"),
    savedEnvMirror: $("saved-env-mirror"),
    envSetupBtn: $("env-setup-btn"),
    envImportPath: $("env-import-path"),
    envImportBtn: $("env-import-btn"),
    envImportResult: $("env-import-result"),
    console: $("console"),
    // server-mode sections (hidden in server mode / shown read-only)
    sectionServerInfo: $("section-server-info"),
    sectionConn: $("section-conn"),
    sectionCert: $("section-cert"),
    sectionEnv: $("section-env"),
    srvModel: $("srv-model"),
    srvParams: $("srv-params"),
    // login modal (server mode)
    loginScrim: $("login-scrim"),
    loginToken: $("login-token"),
    loginToggle: $("login-toggle"),
    loginError: $("login-error"),
    loginSubmit: $("login-submit"),
    // toasts
    toasts: $("toasts"),
  };

  /* ============================ UTILS ============================ */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function relTime(ts) {
    if (!ts) return "";
    const then = typeof ts === "number" ? ts : Date.parse(ts);
    if (isNaN(then)) return "";
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60) return "только что";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " мин назад";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " ч назад";
    const d = Math.floor(h / 24);
    if (d < 7) return d + " дн назад";
    try { return new Date(then).toLocaleDateString("ru-RU"); } catch (_) { return ""; }
  }
  function scrollStreamToBottom() {
    dom.stream.scrollTop = dom.stream.scrollHeight;
  }

  /* ============================ AUTH / TOKEN STORE ============================
   * Server ("multi-tenant") mode keeps a per-user CogniVault token in
   * localStorage under `cvToken`. It is attached as `Authorization: Bearer …`
   * to every /api/* call. In local mode there is no token → header omitted and
   * the backend ignores auth entirely.
   */
  const TOKEN_KEY = "cvToken";
  const THEME_KEY = "cvTheme"; // server mode stores theme client-side (no PUT /api/config)
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; } }
  function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function authHeaders() { const t = getToken(); return t ? { Authorization: "Bearer " + t } : {}; }
  function isServerMode() { return !!(state.config && state.config.mode === "server"); }
  function unauthorizedError() { const e = new Error("UNAUTHORIZED"); e.status = 401; e.handled = true; return e; }
  // Central 401 handler: wipe the token, hide identity, reopen the login modal.
  function handleUnauthorized(message) {
    clearToken();
    if (dom.identity) dom.identity.hidden = true;
    showLogin(message || "Токен истёк или отозван");
  }

  /* ============================ API HELPERS ============================ */
  async function apiGet(path) {
    const res = await fetch(path, { headers: Object.assign({ Accept: "application/json" }, authHeaders()) });
    if (res.status === 401 && isServerMode()) { handleUnauthorized(); throw unauthorizedError(); }
    if (!res.ok) throw new Error(path + " → " + res.status);
    return res.json();
  }
  async function apiSend(path, method, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json" }, authHeaders()),
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && isServerMode()) { handleUnauthorized(); throw unauthorizedError(); }
    if (!res.ok) {
      let msg = path + " → " + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : null;
  }

  /* ============================ SSE PARSER ============================
   * Consume a POST SSE stream via fetch + ReadableStream. onEvent({event,data}).
   * Uses streaming TextDecoder so multi-byte (Cyrillic) chars split across
   * network chunks are reassembled correctly. Blocks are separated by \n\n;
   * each block has `event:` and (possibly multi-line) `data:` fields.
   */
  async function consumeSSE(response, onEvent) {
    const reader = response.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buffer = "";

    const dispatch = (block) => {
      if (!block.trim()) return;
      let ev = "message";
      const dataLines = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue; // comment / blank
        if (line.startsWith("event:")) {
          ev = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      const dataStr = dataLines.join("\n");
      let data = dataStr;
      if (dataStr) { try { data = JSON.parse(dataStr); } catch (_) { data = dataStr; } }
      onEvent({ event: ev, data });
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatch(block);
      }
    }
    // flush decoder + any trailing block
    buffer += dec.decode();
    if (buffer.indexOf("\n\n") !== -1) {
      const parts = buffer.split("\n\n");
      for (const p of parts) dispatch(p);
    } else if (buffer.trim()) {
      dispatch(buffer);
    }
  }

  /* ============================ MARKDOWN (tiny, safe) ============================
   * Supported: ``` fenced code ```, ### headings, - / 1. lists, **bold**,
   * `inline code`, [text](url) links, paragraphs. HTML is escaped FIRST.
   */
  // private-use sentinels wrap protected inline-code placeholders so the
  // digit index cannot collide with real digits in the surrounding text.
  var CODE_OPEN = "\uE000";
  var CODE_CLOSE = "\uE001";
  function renderInline(text) {
    let s = escapeHtml(text);
    // inline code first (protect its contents from other rules)
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_m, c) {
      codes.push("<code>" + c + "</code>");
      return CODE_OPEN + (codes.length - 1) + CODE_CLOSE;
    });
    // bold
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // links [text](url) — only http(s)/relative, escaped href
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, t, url) {
      if (!/^(https?:\/\/|\/|mailto:)/i.test(url)) return t;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    // restore inline code
    s = s.replace(/\uE000(\d+)\uE001/g, function (_m, i) { return codes[Number(i)]; });
    return s;
  }

  function renderMarkdown(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;
    let listType = null;     // "ul" | "ol" | null
    let paraBuf = [];

    const flushPara = () => {
      if (paraBuf.length) {
        html += "<p>" + renderInline(paraBuf.join(" ")) + "</p>";
        paraBuf = [];
      }
    };
    const closeList = () => { if (listType) { html += "</" + listType + ">"; listType = null; } };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        flushPara(); closeList();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++; // consume closing fence
        html += "<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
        continue;
      }

      // heading ###
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) { flushPara(); closeList(); html += "<h3>" + renderInline(h[1]) + "</h3>"; i++; continue; }

      // unordered list
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
        html += "<li>" + renderInline(ul[1]) + "</li>";
        i++; continue;
      }
      // ordered list
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
        html += "<li>" + renderInline(ol[1]) + "</li>";
        i++; continue;
      }

      // blank line → paragraph / list break
      if (!line.trim()) { flushPara(); closeList(); i++; continue; }

      // plain text → accumulate into paragraph
      closeList();
      paraBuf.push(line.trim());
      i++;
    }
    flushPara(); closeList();
    return html;
  }

  /* ============================ TOASTS ============================ */
  function toast(kind, title, message) {
    const t = el("div", "toast " + kind);
    const body = el("div", "tbody");
    body.appendChild(el("div", "tt", title));
    if (message) body.appendChild(el("div", "tm", message));
    t.appendChild(body);
    const x = el("button", "tx", "✕");
    x.setAttribute("aria-label", "Закрыть уведомление");
    x.addEventListener("click", () => t.remove());
    t.appendChild(x);
    dom.toasts.appendChild(t);
    if (kind !== "err") setTimeout(() => t.remove(), 4000);
  }

  /* ============================ STATUS ============================ */
  function setPill(pill, kind, label) {
    pill.className = "pill " + kind;
    const t = pill.querySelector(".pt");
    if (t) t.textContent = label;
  }

  async function refreshStatus(envSettingUp) {
    let st;
    try {
      st = await apiGet("/api/status");
    } catch (_) {
      setPill(dom.pillCogni, "err", "Нет связи");
      setPill(dom.pillCert, "err", "Нет сертификатов");
      setPill(dom.pillEnv, "warn", "Не настроено");
      updateBanner({ cognivault: { ok: false }, env: {} });
      return;
    }
    const cv = st.cognivault || {};
    const gc = st.gigachat || {};
    const env = st.env || {};
    // CogniVault
    setPill(dom.pillCogni, cv.ok ? "ok" : "err", cv.ok ? "Подключено" : "Нет связи");
    // Certificates
    const certs = gc.cert_exists && gc.key_exists;
    setPill(dom.pillCert, certs ? "ok" : "err", certs ? "Сертификаты" : "Нет сертификатов");
    // Environment
    if (envSettingUp) {
      setPill(dom.pillEnv, "warn", "Настраиваю окружение…");
    } else if (env.venv_exists) {
      setPill(dom.pillEnv, "ok", "Окружение готово");
    } else {
      setPill(dom.pillEnv, "warn", "Не настроено");
    }
    updateBanner(st);
    return st;
  }

  function updateBanner(st) {
    const cv = (st && st.cognivault) || {};
    // Server mode: env/token setup banners don't apply (admin-managed).
    // Only surface a lost-connection warning.
    if (isServerMode()) {
      if (st && cv.ok === false) {
        dom.bannerText.textContent = "Нет связи с сервером CogniVault. Попробуйте позже.";
        dom.banner.hidden = false;
      } else {
        dom.banner.hidden = true;
      }
      return;
    }
    const env = (st && st.env) || {};
    const hasToken = state.config && state.config.cognivault &&
      !!state.config.cognivault.token;
    const envReady = env.venv_exists;
    let text = "";
    if (st && cv.ok === false) {
      text = "Нет связи с сервером CogniVault. Проверьте, что служба запущена.";
    } else if (!envReady) {
      text = "Окружение не настроено. Откройте Настройки → Окружение, чтобы завершить установку.";
    } else if (!hasToken) {
      text = "Не задан токен доступа. Откройте Настройки → Подключение.";
    }
    if (text) {
      dom.bannerText.textContent = text;
      dom.banner.hidden = false;
    } else {
      dom.banner.hidden = true;
    }
  }

  /* ============================ THEME ============================ */
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme"); // auto
    dom.themeBtn.textContent = theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐";
  }
  function getServerTheme() { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (_) { return "auto"; } }
  async function cycleTheme() {
    const order = ["auto", "light", "dark"];
    // Server mode: theme is client-only (no PUT /api/config — it would 403).
    if (isServerMode()) {
      const cur = getServerTheme();
      const next = order[(order.indexOf(cur) + 1) % order.length];
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
      return;
    }
    const cur = (state.config && state.config.ui && state.config.ui.theme) || "auto";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    applyTheme(next);
    if (!state.config.ui) state.config.ui = {};
    state.config.ui.theme = next;
    try {
      await apiSend("/api/config", "PUT", { ui: { theme: next } });
    } catch (e) {
      toast("err", "Не удалось сохранить тему", e.message);
    }
  }

  /* ============================ SERVER MODE (multi-tenant) ============================ */
  function showLogin(message) {
    if (dom.loginError) {
      if (message) { dom.loginError.textContent = message; dom.loginError.hidden = false; }
      else { dom.loginError.textContent = ""; dom.loginError.hidden = true; }
    }
    if (dom.loginToken) dom.loginToken.value = "";
    if (dom.loginScrim) dom.loginScrim.hidden = false;
    if (dom.loginToken) { try { dom.loginToken.focus(); } catch (_) {} }
  }
  function hideLogin() {
    if (dom.loginScrim) dom.loginScrim.hidden = true;
    if (dom.loginError) { dom.loginError.hidden = true; dom.loginError.textContent = ""; }
  }
  function showLoginError(msg) {
    if (dom.loginError) { dom.loginError.textContent = msg; dom.loginError.hidden = false; }
  }
  function toggleLoginTokenVisibility() {
    state.loginTokenVisible = !state.loginTokenVisible;
    dom.loginToken.type = state.loginTokenVisible ? "text" : "password";
    dom.loginToggle.textContent = state.loginTokenVisible ? "Скрыть" : "Показать";
    dom.loginToggle.setAttribute("aria-pressed", String(state.loginTokenVisible));
  }

  // GET /api/whoami — 200 {userId,ok}; 401 invalid; 503 CV unavailable.
  async function whoami(token) {
    const t = token || getToken();
    const res = await fetch("/api/whoami", {
      headers: { Accept: "application/json", Authorization: "Bearer " + t },
    });
    if (res.ok) return res.json();
    const err = new Error("whoami → " + res.status);
    err.status = res.status;
    throw err;
  }

  async function submitLogin() {
    const token = (dom.loginToken.value || "").trim();
    if (!token) { showLoginError("Введите токен"); return; }
    dom.loginSubmit.disabled = true;
    try {
      const who = await whoami(token);
      setToken(token);
      hideLogin();
      onLoggedIn(who);
    } catch (e) {
      if (e.status === 401) showLoginError("Неверный токен");
      else if (e.status === 503) showLoginError("CogniVault недоступен, попробуйте позже");
      else showLoginError("Не удалось войти. Попробуйте ещё раз.");
    } finally {
      dom.loginSubmit.disabled = false;
    }
  }

  // Boot path for server mode: verify an existing token or prompt for login.
  async function bootServer() {
    const token = getToken();
    if (!token) { showLogin(); return; }
    try {
      const who = await whoami(token);
      onLoggedIn(who);
    } catch (e) {
      if (e.status === 503) {
        showLogin("CogniVault недоступен, попробуйте позже");
      } else {
        clearToken();
        showLogin(e.status === 401 ? "Токен истёк или отозван" : undefined);
      }
    }
  }

  function onLoggedIn(who) {
    const userId = (who && (who.userId || who.user_id)) || "";
    if (dom.identityUser) dom.identityUser.textContent = userId;
    if (dom.identity) dom.identity.hidden = false;
    applyServerConfig();
    refreshStatus();
    loadHistory();
  }

  function logout() {
    clearToken();
    if (dom.identity) dom.identity.hidden = true;
    // reset the visible conversation so the next user starts clean
    if (state.abort) state.abort.abort();
    state.chatId = null;
    state.messages = [];
    renderWelcome();
    if (dom.chatlist) dom.chatlist.textContent = "";
    if (dom.historyCount) dom.historyCount.textContent = "";
    showLogin();
  }

  // Hide admin-managed / local-only UI; reveal the read-only info section.
  function applyServerModeUI() {
    if (dom.sectionConn) dom.sectionConn.hidden = true;
    if (dom.sectionCert) dom.sectionCert.hidden = true;
    if (dom.sectionEnv) dom.sectionEnv.hidden = true;
    if (dom.sectionServerInfo) dom.sectionServerInfo.hidden = false;
    // cert/env pills are admin/local concerns — hide them
    if (dom.pillCert) dom.pillCert.hidden = true;
    if (dom.pillEnv) dom.pillEnv.hidden = true;
  }

  // Apply the safe config subset returned in server mode (no edit forms).
  function applyServerConfig() {
    const c = state.config || {};
    const rag = c.rag || {};
    state.rag = rag.default_on !== false;
    applyRagUI();
    applyTheme(getServerTheme());
    const g = c.gigachat || {};
    if (dom.srvModel) dom.srvModel.textContent = g.model || "—";
    if (dom.srvParams) {
      const parts = [];
      if (g.temperature != null) parts.push("температура: " + g.temperature);
      if (g.max_tokens != null) parts.push("макс. токенов: " + g.max_tokens);
      if (g.model_context_tokens != null) parts.push("контекст: " + g.model_context_tokens);
      dom.srvParams.textContent = parts.join(" · ");
    }
  }

  /* ============================ SETTINGS ============================ */
  function bindConfigToForm() {
    const c = state.config || {};
    const cv = c.cognivault || {};
    const giga = c.gigachat || {};
    dom.cfgCognivaultUrl.value = cv.base_url || "";
    dom.cfgToken.value = cv.token || "";
    dom.cfgGigaUrl.value = giga.base_url || "";
    dom.cfgModel.value = giga.model || "GigaChat-3-Ultra-preview";
    dom.cfgCert.value = giga.cert_path || "";
    dom.cfgKey.value = giga.key_path || "";
    dom.cfgPassphrase.value = giga.key_passphrase || "";
    dom.cfgCa.value = giga.ca_path || "";
    dom.cfgVerifySsl.checked = giga.verify_ssl !== false;

    // env / SberOSC mirror
    const env = c.env || {};
    if (dom.cfgPipIndex) dom.cfgPipIndex.value = env.pip_index_url || "";
    if (dom.cfgPipToken) dom.cfgPipToken.value = env.pip_token || "";

    // RAG defaults
    const rag = c.rag || {};
    state.rag = rag.default_on !== false;
    applyRagUI();

    // theme
    applyTheme((c.ui && c.ui.theme) || "auto");
  }

  function flashSaved(node) {
    node.hidden = false;
    setTimeout(() => { node.hidden = true; }, 2500);
  }

  async function saveConnection() {
    const payload = {
      cognivault: {
        base_url: dom.cfgCognivaultUrl.value.trim(),
        token: dom.cfgToken.value,
      },
    };
    dom.saveConn.disabled = true;
    try {
      const updated = await apiSend("/api/config", "PUT", payload);
      if (updated) state.config = updated; else Object.assign(state.config.cognivault || (state.config.cognivault = {}), payload.cognivault);
      flashSaved(dom.savedConn);
      toast("ok", "Настройки сохранены", "Подключение обновлено");
      await refreshStatus();
    } catch (e) {
      toast("err", "Ошибка сохранения", e.message);
    } finally {
      dom.saveConn.disabled = false;
    }
  }

  async function saveCertificates() {
    const payload = {
      gigachat: {
        base_url: dom.cfgGigaUrl.value.trim(),
        model: dom.cfgModel.value.trim(),
        cert_path: dom.cfgCert.value.trim(),
        key_path: dom.cfgKey.value.trim(),
        key_passphrase: dom.cfgPassphrase.value,
        ca_path: dom.cfgCa.value.trim(),
        verify_ssl: dom.cfgVerifySsl.checked,
      },
    };
    dom.saveCert.disabled = true;
    try {
      const updated = await apiSend("/api/config", "PUT", payload);
      if (updated) state.config = updated; else state.config.gigachat = payload.gigachat;
      flashSaved(dom.savedCert);
      toast("ok", "Настройки сохранены", "Сертификаты обновлены");
      await refreshStatus();
    } catch (e) {
      toast("err", "Ошибка сохранения", e.message);
    } finally {
      dom.saveCert.disabled = false;
    }
  }

  function toggleTokenVisibility() {
    state.tokenVisible = !state.tokenVisible;
    dom.cfgToken.type = state.tokenVisible ? "text" : "password";
    dom.tokenToggle.textContent = state.tokenVisible ? "Скрыть" : "Показать";
    dom.tokenToggle.setAttribute("aria-pressed", String(state.tokenVisible));
  }

  function togglePipTokenVisibility() {
    state.pipTokenVisible = !state.pipTokenVisible;
    dom.cfgPipToken.type = state.pipTokenVisible ? "text" : "password";
    dom.pipTokenToggle.textContent = state.pipTokenVisible ? "Скрыть" : "Показать";
    dom.pipTokenToggle.setAttribute("aria-pressed", String(state.pipTokenVisible));
  }

  async function saveEnvMirror() {
    const payload = {
      env: {
        pip_index_url: dom.cfgPipIndex.value.trim(),
        pip_token: dom.cfgPipToken.value,
      },
    };
    dom.saveEnvMirror.disabled = true;
    try {
      const updated = await apiSend("/api/config", "PUT", payload);
      if (updated) state.config = updated;
      else Object.assign(state.config.env || (state.config.env = {}), payload.env);
      flashSaved(dom.savedEnvMirror);
      toast("ok", "Настройки сохранены", "Зеркало PyPI обновлено");
    } catch (e) {
      toast("err", "Ошибка сохранения", e.message);
    } finally {
      dom.saveEnvMirror.disabled = false;
    }
  }

  /* ---- drawer open/close + focus trap ---- */
  let lastFocused = null;
  function openDrawer() {
    lastFocused = document.activeElement;
    dom.scrim.hidden = false;
    dom.drawer.hidden = false;
    document.addEventListener("keydown", drawerKeydown, true);
    const first = dom.drawer.querySelector("button, input, select, a[href], textarea");
    if (first) first.focus();
  }
  function closeDrawer() {
    dom.scrim.hidden = true;
    dom.drawer.hidden = true;
    document.removeEventListener("keydown", drawerKeydown, true);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }
  function drawerKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
    if (e.key === "Tab") {
      const items = dom.drawer.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.prototype.filter.call(items, (n) => !n.disabled && n.offsetParent !== null);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  /* ============================ UPLOAD ============================ */
  function handleUploadFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast("err", "Неверный формат", "Загрузите ZIP-архив (.zip)");
      return;
    }
    uploadZip(file);
  }
  async function uploadZip(file) {
    dom.uploadResult.hidden = false;
    dom.uploadResult.textContent = "";
    dom.uploadResult.appendChild(el("span", "pill warn", "Загрузка…"));
    dom.uploadFilelist.hidden = true;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd, headers: authHeaders() });
      if (res.status === 401 && isServerMode()) {
        dom.uploadResult.textContent = "";
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error.message || msg; } catch (_) {}
        throw new Error(msg);
      }
      const r = await res.json();
      renderUploadResult(r);
      toast("ok", "Файлы загружены", "Архив обработан");
    } catch (e) {
      dom.uploadResult.textContent = "";
      dom.uploadResult.appendChild(el("span", "pill err", "Ошибка загрузки"));
      toast("err", "Ошибка загрузки", e.message);
    }
  }
  function renderUploadResult(r) {
    r = r || {};
    const files = r.files || [];
    const uploaded = r.uploaded != null ? r.uploaded : files.length;
    const skipped = r.skipped != null ? r.skipped : 0;
    const total = files.length;
    dom.uploadResult.hidden = false;
    dom.uploadResult.textContent = "";
    const p = el("span", "pill ok");
    p.appendChild(el("span", "dot"));
    p.appendChild(document.createTextNode(
      "Загружено: " + uploaded + " · Пропущено: " + skipped + " · Файлов: " + total));
    dom.uploadResult.appendChild(p);
    if (files.length) {
      dom.uploadFiles.textContent = "";
      files.forEach((f) => dom.uploadFiles.appendChild(el("li", null, typeof f === "string" ? f : (f.path || f.name || ""))));
      dom.uploadFilelist.hidden = false;
    }
  }

  /* ============================ ENVIRONMENT ============================ */
  function logConsole(kind, text, isStep) {
    const line = el("span", isStep ? "step" : "ln");
    if (isStep) {
      line.textContent = "▸ " + text;
    } else {
      // colorize INFO/WARN/ERR prefix if present
      const m = String(text).match(/^\s*(INFO|WARN(?:ING)?|ERR(?:OR)?)\b[:\s]?/i);
      if (m) {
        const lv = m[1].toUpperCase();
        const cls = lv.startsWith("ERR") ? "lv-err" : lv.startsWith("WARN") ? "lv-warn" : "lv-ok";
        const tag = el("span", cls, m[0]);
        line.appendChild(tag);
        line.appendChild(document.createTextNode(text.slice(m[0].length)));
      } else if (kind === "err") {
        line.className = "ln lv-err"; line.textContent = text;
      } else {
        line.textContent = text;
      }
    }
    dom.console.appendChild(line);
    dom.console.scrollTop = dom.console.scrollHeight;
  }

  async function runEnvSetup() {
    dom.envSetupBtn.disabled = true;
    dom.console.textContent = "";
    logConsole("info", "Запуск настройки окружения…", true);
    refreshStatus(true); // show "Настраиваю окружение…"
    try {
      const res = await fetch("/api/env/setup", { method: "POST", headers: Object.assign({ Accept: "text/event-stream" }, authHeaders()) });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      await consumeSSE(res, (ev) => {
        const d = ev.data || {};
        if (ev.event === "step") {
          logConsole("info", (d.label || d.name || String(d)), true);
        } else if (ev.event === "log") {
          logConsole(d.level === "error" ? "err" : "info", d.line != null ? d.line : (d.message != null ? d.message : String(d)));
        } else if (ev.event === "done") {
          logConsole("ok", "Готово.", true);
          toast("ok", "Окружение настроено", "Установка завершена");
        } else if (ev.event === "error") {
          logConsole("err", (d.message || d.code || "Ошибка"));
          toast("err", "Ошибка настройки", d.message || d.code || "");
        }
      });
    } catch (e) {
      logConsole("err", "Ошибка: " + e.message);
      toast("err", "Ошибка настройки окружения", e.message);
    } finally {
      dom.envSetupBtn.disabled = false;
      await refreshStatus();
    }
  }

  async function importEnv() {
    const path = dom.envImportPath.value.trim();
    if (!path) { toast("warn", "Укажите путь", "Введите путь к экспортированному окружению"); return; }
    dom.envImportBtn.disabled = true;
    try {
      const r = await apiSend("/api/env/import", "POST", { path });
      dom.envImportResult.hidden = false;
      dom.envImportResult.textContent = "";
      const imported = (r && r.imported) || [];
      dom.envImportResult.appendChild(el("div", null, "Импортировано: " + imported.length));
      if (imported.length) {
        const ul = el("ul");
        imported.forEach((f) => ul.appendChild(el("li", null, String(f))));
        dom.envImportResult.appendChild(ul);
      }
      if (r && r.backup) {
        dom.envImportResult.appendChild(el("div", "backup", "Резервная копия: " + r.backup));
      }
      toast("ok", "Окружение импортировано", path);
      await refreshStatus();
    } catch (e) {
      toast("err", "Ошибка импорта", e.message);
    } finally {
      dom.envImportBtn.disabled = false;
    }
  }

  /* ============================ CHAT ============================ */
  function applyRagUI() {
    dom.ragSwitch.setAttribute("aria-checked", String(state.rag));
    dom.ragSublabel.textContent = state.rag
      ? "Поиск по базе знаний включён"
      : "Обычный чат GigaChat";
    dom.limitWrap = dom.limitWrap || document.getElementById("limit-wrap");
    if (dom.limitWrap) dom.limitWrap.style.opacity = state.rag ? "1" : ".5";
  }
  function toggleRag() {
    state.rag = !state.rag;
    applyRagUI();
  }

  function clearWelcome() {
    const w = dom.thread.querySelector(".welcome");
    if (w) w.remove();
  }
  function renderWelcome() {
    dom.thread.textContent = "";
    const w = el("div", "welcome");
    w.appendChild(el("h2", null, "Чем помочь?"));
    w.appendChild(el("p", null, "Задайте вопрос про внутренние регламенты и документы. Ответы формируются на основе вашей базы знаний."));
    const sug = el("div", "suggestions");
    ["Что говорит регламент об отпусках?", "Как оформить командировку?", "Кратко изложи политику информационной безопасности"].forEach((txt) => {
      const b = el("button", "suggestion", txt);
      b.type = "button";
      b.addEventListener("click", () => { dom.input.value = txt; autoGrow(); dom.input.focus(); });
      sug.appendChild(b);
    });
    w.appendChild(sug);
    dom.thread.appendChild(w);
  }

  function addMessageNode(role, contentHtmlOrText, opts) {
    opts = opts || {};
    const msg = el("div", "msg " + role);
    const bubble = el("div", "bubble" + (opts.err ? " err-bubble" : ""));
    bubble.appendChild(el("div", "role", role === "user" ? "Вы" : "Ассистент"));
    const content = el("div", "content");
    if (opts.asHtml) content.innerHTML = contentHtmlOrText;
    else content.textContent = contentHtmlOrText;
    bubble.appendChild(content);
    msg.appendChild(bubble);
    dom.thread.appendChild(msg);
    return { msg, bubble, content };
  }

  const DEPTH_LABEL = { file: "файл", section: "раздел", chunk: "фрагмент" };
  function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function renderSources(bubble, sources, contextChars) {
    if (!sources || !sources.length) return;
    const wrap = el("div", "sources");
    wrap.appendChild(el("span", "eyebrow", "Источники"));
    const chips = el("div", "chips");
    sources.forEach((s) => {
      const chip = el("div", "chip");
      chip.appendChild(el("span", "ct", s.title || s.name || "Документ"));
      if (s.path) chip.appendChild(el("span", "cp", s.path));
      const depthLabel = DEPTH_LABEL[s.depth];
      if (depthLabel) chip.appendChild(el("span", "cd", depthLabel));
      if (s.score != null) {
        const score = typeof s.score === "number" ? s.score.toFixed(3) : String(s.score);
        chip.appendChild(el("span", "cs", score));
      }
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    // subtle, non-interactive context summary
    const count = sources.length;
    const noun = pluralRu(count, "источник", "источника", "источников");
    let info = count + " " + noun;
    if (typeof contextChars === "number" && contextChars > 0) {
      info = "контекст: " + contextChars.toLocaleString("ru-RU") + " симв. · " + info;
    }
    wrap.appendChild(el("div", "ctx-info", info));
    bubble.appendChild(wrap);
  }

  function renderThread() {
    dom.thread.textContent = "";
    if (!state.messages.length) { renderWelcome(); return; }
    state.messages.forEach((m) => {
      if (m.role === "user") {
        addMessageNode("user", m.content);
      } else {
        const { bubble, content } = addMessageNode("assistant", "", { asHtml: true });
        content.innerHTML = renderMarkdown(m.content || "");
        renderSources(bubble, m.sources, m.context_chars);
      }
    });
    scrollStreamToBottom();
  }

  function setStreamingUI(on) {
    state.streaming = on;
    if (on) {
      dom.sendBtn.textContent = "Стоп";
      dom.sendBtn.classList.add("stop");
      dom.sendBtn.disabled = false;
    } else {
      dom.sendBtn.textContent = "Отправить";
      dom.sendBtn.classList.remove("stop");
      dom.sendBtn.disabled = false;
    }
  }

  async function sendMessage() {
    if (state.streaming) { // acts as Stop
      if (state.abort) state.abort.abort();
      return;
    }
    const text = dom.input.value.trim();
    if (!text) return;

    clearWelcome();
    // user turn
    state.messages.push({ role: "user", content: text });
    addMessageNode("user", text);
    dom.input.value = "";
    autoGrow();
    scrollStreamToBottom();

    // assistant bubble under construction
    const { bubble, content } = addMessageNode("assistant", "", { asHtml: true });
    const cursor = el("span", "cursor");
    content.appendChild(cursor);
    let answer = "";
    let noticeNode = null;
    let sourcesData = null;
    let contextChars = null;
    scrollStreamToBottom();

    setStreamingUI(true);
    state.abort = new AbortController();

    const payload = {
      messages: state.messages.map((m) => ({ role: m.role, content: m.content })),
      rag: state.rag,
      chat_id: state.chatId,
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", Accept: "text/event-stream" }, authHeaders()),
        body: JSON.stringify(payload),
        signal: state.abort.signal,
      });
      if (res.status === 401 && isServerMode()) {
        if (cursor.parentNode) cursor.remove();
        if (bubble.parentNode) bubble.parentNode.remove();
        handleUnauthorized();
        return; // finally still resets streaming UI
      }
      if (!res.ok || !res.body) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error.message; } catch (_) {}
        throw new Error(msg);
      }

      await consumeSSE(res, (ev) => {
        const d = ev.data || {};
        switch (ev.event) {
          case "meta":
            if (d.chat_id) state.chatId = d.chat_id;
            break;
          case "sources":
            sourcesData = d.sources || d.items || (Array.isArray(d) ? d : []);
            if (typeof d.context_chars === "number") contextChars = d.context_chars;
            // render sources strip under the growing bubble (remove old first)
            const oldS = bubble.querySelector(".sources");
            if (oldS) oldS.remove();
            renderSources(bubble, sourcesData, contextChars);
            scrollStreamToBottom();
            break;
          case "notice":
            if (!noticeNode) {
              noticeNode = el("div", "notice");
              content.parentNode.insertBefore(noticeNode, content);
            }
            noticeNode.textContent = d.message || d.text || "Поиск по базе недоступен…";
            toast("warn", "Внимание", noticeNode.textContent);
            break;
          case "token": {
            const txt = d.text != null ? d.text : (typeof d === "string" ? d : "");
            answer += txt;
            cursor.parentNode.insertBefore(document.createTextNode(txt), cursor);
            scrollStreamToBottom();
            break;
          }
          case "done":
            if (cursor.parentNode) cursor.remove();
            // finalize with markdown render
            content.innerHTML = renderMarkdown(answer);
            state.messages.push({ role: "assistant", content: answer, sources: sourcesData, context_chars: contextChars, rag: state.rag });
            break;
          case "error": {
            if (cursor.parentNode) cursor.remove();
            bubble.classList.add("err-bubble");
            let msg = (d.code ? "[" + d.code + "] " : "") + (d.message || "Ошибка");
            if (d.detail) msg += "\n" + d.detail;
            content.textContent = msg;
            toast("err", "Ошибка", d.message || d.code || "");
            break;
          }
        }
      });
    } catch (e) {
      if (e.name === "AbortError") {
        // normal cancellation — keep partial answer
        if (cursor.parentNode) cursor.remove();
        if (answer) {
          content.innerHTML = renderMarkdown(answer);
          state.messages.push({ role: "assistant", content: answer, sources: sourcesData, context_chars: contextChars, rag: state.rag });
        } else {
          bubble.parentNode && bubble.parentNode.remove();
        }
      } else {
        if (cursor.parentNode) cursor.remove();
        bubble.classList.add("err-bubble");
        content.textContent = "Ошибка соединения: " + e.message;
        toast("err", "Ошибка соединения", e.message);
      }
    } finally {
      setStreamingUI(false);
      state.abort = null;
      loadHistory();
    }
  }

  function autoGrow() {
    dom.input.style.height = "auto";
    dom.input.style.height = Math.min(200, dom.input.scrollHeight) + "px";
  }

  /* ============================ HISTORY ============================ */
  async function loadHistory() {
    let data;
    try { data = await apiGet("/api/history"); } catch (_) { return; }
    const items = (data && Array.isArray(data.chats)) ? data.chats : (Array.isArray(data) ? data : []);
    renderHistory(items);
  }

  function renderHistory(items) {
    dom.chatlist.textContent = "";
    dom.historyCount.textContent = items.length ? String(items.length) : "";
    if (!items.length) {
      const empty = el("div", "rail-empty", "Пока нет сохранённых чатов. Начните новый разговор.");
      dom.chatlist.appendChild(empty);
      return;
    }
    items.forEach((it) => {
      const id = it.id != null ? it.id : it.chat_id;
      const item = el("button", "chatitem" + (id === state.chatId ? " active" : ""));
      item.type = "button";
      item.appendChild(el("span", "t", it.title || "Без названия"));
      const meta = el("div", "m");
      meta.appendChild(el("span", null, relTime(it.updated_at || it.created_at || it.ts)));
      if (it.rag || it.has_rag) meta.appendChild(el("span", "tag", "RAG"));
      item.appendChild(meta);
      item.addEventListener("click", () => openChat(id));

      const del = el("button", "del", "🗑");
      del.type = "button";
      del.setAttribute("aria-label", "Удалить чат");
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteChat(id, it.title); });
      item.appendChild(del);

      dom.chatlist.appendChild(item);
    });
  }

  async function openChat(id) {
    try {
      const data = await apiGet("/api/history/" + encodeURIComponent(id));
      const msgs = (data && (data.messages || data.turns)) || [];
      state.chatId = id;
      state.messages = msgs.map((m) => ({
        role: m.role,
        content: m.content,
        sources: m.sources,
        context_chars: m.context_chars,
        rag: m.rag,
      }));
      renderThread();
      // reflect active state
      Array.prototype.forEach.call(dom.chatlist.children, (c) => c.classList && c.classList.remove("active"));
      loadHistory();
    } catch (e) {
      toast("err", "Не удалось открыть чат", e.message);
    }
  }

  async function deleteChat(id, title) {
    if (!confirm("Удалить чат «" + (title || "Без названия") + "»?")) return;
    try {
      await apiSend("/api/history/" + encodeURIComponent(id), "DELETE");
      if (id === state.chatId) newChat();
      toast("ok", "Чат удалён", "");
      loadHistory();
    } catch (e) {
      toast("err", "Не удалось удалить", e.message);
    }
  }

  function newChat() {
    if (state.abort) state.abort.abort();
    state.chatId = null;
    state.messages = [];
    renderWelcome();
    dom.input.focus();
    Array.prototype.forEach.call(dom.chatlist.children, (c) => c.classList && c.classList.remove("active"));
  }

  /* ============================ INIT ============================ */
  function wireEvents() {
    // header
    dom.themeBtn.addEventListener("click", cycleTheme);
    dom.settingsBtn.addEventListener("click", openDrawer);
    dom.drawerClose.addEventListener("click", closeDrawer);
    dom.scrim.addEventListener("click", closeDrawer);
    dom.bannerBtn.addEventListener("click", openDrawer);

    // rail
    dom.newchatBtn.addEventListener("click", newChat);

    // composer
    dom.ragSwitch.addEventListener("click", toggleRag);
    dom.sendBtn.addEventListener("click", sendMessage);
    dom.input.addEventListener("input", autoGrow);
    dom.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // settings §1/§2
    dom.tokenToggle.addEventListener("click", toggleTokenVisibility);
    dom.saveConn.addEventListener("click", saveConnection);
    dom.saveCert.addEventListener("click", saveCertificates);

    // upload
    dom.dropzone.addEventListener("click", () => dom.fileInput.click());
    dom.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dom.fileInput.click(); }
    });
    dom.fileInput.addEventListener("change", () => handleUploadFile(dom.fileInput.files[0]));
    ["dragenter", "dragover"].forEach((ev) => dom.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); dom.dropzone.classList.add("drag");
    }));
    ["dragleave", "dragend"].forEach((ev) => dom.dropzone.addEventListener(ev, () => dom.dropzone.classList.remove("drag")));
    dom.dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove("drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleUploadFile(f);
    });

    // env
    dom.pipTokenToggle.addEventListener("click", togglePipTokenVisibility);
    dom.saveEnvMirror.addEventListener("click", saveEnvMirror);
    dom.envSetupBtn.addEventListener("click", runEnvSetup);
    dom.envImportBtn.addEventListener("click", importEnv);

    // server-mode login / logout
    if (dom.loginSubmit) dom.loginSubmit.addEventListener("click", submitLogin);
    if (dom.loginToggle) dom.loginToggle.addEventListener("click", toggleLoginTokenVisibility);
    if (dom.loginToken) dom.loginToken.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitLogin(); }
    });
    if (dom.logoutBtn) dom.logoutBtn.addEventListener("click", logout);
  }

  async function init() {
    wireEvents();
    renderWelcome();
    // config first (drives mode + theme + rag defaults + banner). No auth needed
    // for GET /api/config in either mode.
    try {
      state.config = await apiGet("/api/config");
    } catch (e) {
      state.config = { mode: "local", cognivault: {}, gigachat: {}, rag: {}, ui: {} };
      toast("err", "Не удалось загрузить конфигурацию", e.message);
    }

    if (isServerMode()) {
      // Multi-tenant: hide admin/local UI, then gate on a valid token.
      applyServerModeUI();
      await bootServer();
    } else {
      // Local mode: unchanged behavior.
      bindConfigToForm();
      await refreshStatus();
      await loadHistory();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
