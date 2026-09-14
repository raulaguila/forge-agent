(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const approvalEl = document.getElementById("approval");
  const usageEl = document.getElementById("usage");
  const mentionPopup = document.getElementById("mentionPopup");
  const contextStrip = document.getElementById("contextStrip");
  const overflowMenu = document.getElementById("overflowMenu");
  const modeMenu = document.getElementById("modeMenu");
  const modelMenu = document.getElementById("modelMenu");
  const modelList = document.getElementById("modelList");
  const settingsOverlay = document.getElementById("settingsOverlay");

  const btnSend = document.getElementById("btnSend");
  const btnStop = document.getElementById("btnStop");
  const btnNew = document.getElementById("btnNew");
  const btnMode = document.getElementById("btnMode");
  const btnModel = document.getElementById("btnModel");
  const btnMenu = document.getElementById("btnMenu");
  const btnDemo = document.getElementById("btnDemo");
  const btnClearContext = document.getElementById("btnClearContext");
  const btnComposerSettings = document.getElementById("btnComposerSettings");
  const btnModelSettings = document.getElementById("btnModelSettings");
  const btnAddModel = document.getElementById("btnAddModel");
  const btnCloseSettings = document.getElementById("btnCloseSettings");
  const btnSettingsProfiles = document.getElementById("btnSettingsProfiles");
  const btnSettingsKey = document.getElementById("btnSettingsKey");
  const modeIcon = document.getElementById("modeIcon");
  const modeLabel = document.getElementById("modeLabel");
  const modelLabel = document.getElementById("modelLabel");

  let busy = false;
  let demo = false;
  let autonomy = "agent";
  let currentModel = "modelo";
  let currentProvider = "";
  let currentProfile = "";
  let hasKey = false;
  let models = [];
  let streamNode = null;
  let statusNode = null;
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionQueryStart = -1;
  let mentionTimer = null;
  const toolCards = new Map();

  const MODE_META = {
    ask: { label: "Ask", icon: "💬" },
    plan: { label: "Plan", icon: "☰" },
    agent: { label: "Agent", icon: "✦" },
    auto: { label: "Auto", icon: "⚡" },
  };

  const DEMO_MODELS = [
    { id: "claude-sonnet-4", label: "claude-sonnet-4" },
    { id: "gpt-4.1", label: "gpt-4.1" },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function shortLabel(text, max) {
    const t = String(text || "");
    const limit = max || 18;
    return t.length > limit ? t.slice(0, limit - 1) + "…" : t;
  }

  function closeModeMenu() {
    if (!modeMenu || !btnMode) return;
    modeMenu.classList.add("hidden");
    btnMode.setAttribute("aria-expanded", "false");
  }

  function closeModelMenu() {
    if (!modelMenu || !btnModel) return;
    modelMenu.classList.add("hidden");
    btnModel.setAttribute("aria-expanded", "false");
  }

  function closeOverflow() {
    if (!overflowMenu || !btnMenu) return;
    overflowMenu.classList.add("hidden");
    btnMenu.setAttribute("aria-expanded", "false");
  }

  function closeMenus() {
    closeModeMenu();
    closeModelMenu();
    closeOverflow();
  }

  function toggleModeMenu(e) {
    if (e) e.stopPropagation();
    closeModelMenu();
    closeOverflow();
    if (!modeMenu || !btnMode) return;
    const willOpen = modeMenu.classList.contains("hidden");
    modeMenu.classList.toggle("hidden", !willOpen);
    btnMode.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) syncModeChecks();
  }

  function toggleModelMenu(e) {
    if (e) e.stopPropagation();
    closeModeMenu();
    closeOverflow();
    if (!modelMenu || !btnModel) return;
    const willOpen = modelMenu.classList.contains("hidden");
    modelMenu.classList.toggle("hidden", !willOpen);
    btnModel.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) {
      renderModelList();
      if (!demo) vscode.postMessage({ type: "listModels" });
    }
  }

  function syncModeChecks() {
    if (!modeMenu) return;
    modeMenu.querySelectorAll(".pop-item[data-mode]").forEach(function (item) {
      const selected = item.getAttribute("data-mode") === autonomy;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.classList.toggle("active", selected);
    });
  }

  function setMode(mode) {
    autonomy = mode || "agent";
    const meta = MODE_META[autonomy] || MODE_META.agent;
    if (modeLabel) modeLabel.textContent = meta.label;
    if (modeIcon) modeIcon.textContent = meta.icon;
    syncModeChecks();
  }

  function setModelLabel(model) {
    currentModel = model || "modelo";
    if (modelLabel) modelLabel.textContent = shortLabel(currentModel, 22);
    if (btnModel) {
      btnModel.title = (currentProfile || currentProvider || "provider") + " · " + currentModel;
    }
  }

  function renderModelList() {
    if (!modelList) return;
    modelList.innerHTML = "";
    const list = models.length
      ? models
      : demo
        ? DEMO_MODELS
        : [{ id: currentModel, label: currentModel }];
    list.forEach(function (m) {
      const id = m.id || m.label || String(m);
      const label = m.label || m.id || String(m);
      const item = el("button", "pop-item");
      item.type = "button";
      item.setAttribute("role", "option");
      const selected = id === currentModel;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) item.classList.add("active");
      item.appendChild(el("span", "pop-icon", "▣"));
      item.appendChild(el("span", "pop-label", label));
      item.appendChild(el("span", "pop-check"));
      item.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectModel(id, label);
      });
      modelList.appendChild(item);
    });
  }

  function selectModel(id, label) {
    setModelLabel(label || id);
    closeModelMenu();
    if (!demo) vscode.postMessage({ type: "selectModel", model: id });
  }

  function openSettingsOverlay() {
    closeMenus();
    if (!settingsOverlay) return;
    const profileEl = document.getElementById("settingsProfile");
    const providerEl = document.getElementById("settingsProvider");
    const modelEl = document.getElementById("settingsModel");
    const keyEl = document.getElementById("settingsKey");
    if (profileEl) profileEl.textContent = currentProfile || "—";
    if (providerEl) providerEl.textContent = currentProvider || "—";
    if (modelEl) modelEl.textContent = currentModel || "—";
    if (keyEl) keyEl.textContent = hasKey ? "configurada" : "ausente";
    settingsOverlay.classList.remove("hidden");
    settingsOverlay.setAttribute("aria-hidden", "false");
  }

  function closeSettingsOverlay() {
    if (!settingsOverlay) return;
    settingsOverlay.classList.add("hidden");
    settingsOverlay.setAttribute("aria-hidden", "true");
  }

  function ensureList() {
    const empty = messagesEl.querySelector(".empty");
    if (empty) empty.remove();
  }

  function showEmpty() {
    messagesEl.innerHTML = "";
    toolCards.clear();
    statusNode = null;
    streamNode = null;
    const box = el("div", "empty");
    box.appendChild(el("div", "hero-mark"));
    box.appendChild(el("h1", null, "Forge"));
    box.appendChild(el("p", null, "Peça uma mudança, investigue um bug ou planeje um refactor."));
    const list = el("div", "empty-suggestions");
    [
      { title: "Explicar este arquivo", sub: "Resuma responsabilidades e riscos", prompt: "Explique o arquivo atual: o que faz, riscos e como testar." },
      { title: "Encontrar e corrigir um bug", sub: "Investigue com tools e proponha o patch", prompt: "Investigue o erro mais recente e proponha uma correção mínima." },
      { title: "Planejar um refactor", sub: "Modo plan · sem editar ainda", prompt: "/plan Refatore o módulo principal para ficar mais testável." },
    ].forEach(function (s) {
      const btn = el("button", "suggestion");
      btn.type = "button";
      btn.appendChild(el("span", "s-title", s.title));
      btn.appendChild(el("span", "s-sub", s.sub));
      btn.addEventListener("click", function () {
        input.value = s.prompt;
        input.focus();
        if (!demo) send();
      });
      list.appendChild(btn);
    });
    box.appendChild(list);
    messagesEl.appendChild(box);
  }

  function appendMessage(kind, text, label) {
    ensureList();
    const node = el("div", "msg " + kind);
    if (label) node.appendChild(el("span", "label", label));
    const body = el("div", "body");
    body.textContent = text || "";
    node.appendChild(body);
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return node;
  }

  function appendRichAssistant(parts) {
    ensureList();
    const node = el("div", "msg assistant");
    node.appendChild(el("span", "label", "Forge"));
    const body = el("div", "body");
    parts.forEach(function (p) {
      if (p.type === "text") body.appendChild(document.createTextNode(p.text));
      else if (p.type === "code") body.appendChild(el("code", "code", p.text));
    });
    node.appendChild(body);
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return node;
  }

  function setTransientStatus(text) {
    ensureList();
    if (!text) {
      if (statusNode) { statusNode.remove(); statusNode = null; }
      return;
    }
    if (!statusNode || !statusNode.isConnected) {
      statusNode = el("div", "msg status");
      statusNode.appendChild(el("span", "pulse"));
      statusNode.appendChild(document.createTextNode(""));
      messagesEl.appendChild(statusNode);
    }
    if (statusNode.childNodes[1]) statusNode.childNodes[1].textContent = " " + text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearTransientStatus() {
    if (statusNode) { statusNode.remove(); statusNode = null; }
  }

  function toolIcon(name) {
    if (/read|list|search|diagnostic|selection|editor/i.test(name || "")) return "R";
    if (/write|edit|apply/i.test(name || "")) return "W";
    if (/terminal|run/i.test(name || "")) return "$";
    return "•";
  }

  function toolTitle(ev) {
    if (ev.summary) return ev.summary;
    const name = ev.toolName || "tool";
    const args = ev.args || {};
    if (args.path) return name + " " + args.path;
    if (args.command) return name + " " + args.command;
    if (args.pattern) return name + " " + args.pattern;
    return name;
  }

  function upsertToolCard(ev, phase) {
    ensureList();
    clearTransientStatus();
    const id = ev.toolCallId || (ev.toolName + "-" + Date.now());
    let card = toolCards.get(id);
    if (!card) {
      const root = el("div", "tool-card");
      const head = el("button", "tool-head");
      head.type = "button";
      const chevron = el("span", "tool-chevron", "▸");
      const icon = el("span", "tool-icon", toolIcon(ev.toolName));
      const title = el("span", "tool-title", toolTitle(ev));
      const meta = el("span", "tool-meta", "");
      head.appendChild(chevron); head.appendChild(icon); head.appendChild(title); head.appendChild(meta);
      const body = el("div", "tool-body hidden");
      const detail = el("pre", "tool-detail");
      body.appendChild(detail);
      head.addEventListener("click", function () {
        const open = body.classList.toggle("hidden") === false;
        chevron.textContent = open ? "▾" : "▸";
      });
      root.appendChild(head); root.appendChild(body);
      messagesEl.appendChild(root);
      toolCards.set(id, { root: root, title: title, meta: meta, detail: detail, icon: icon });
      card = toolCards.get(id);
    }
    card.title.textContent = toolTitle(ev);
    card.icon.textContent = toolIcon(ev.toolName);
    if (phase === "request") {
      card.root.classList.remove("ok", "err");
      card.root.classList.add(ev.requiresApproval ? "pending" : "running");
      card.meta.textContent = ev.requiresApproval ? "aguardando" : "…";
      card.detail.textContent = (ev.args && Object.keys(ev.args).length) ? JSON.stringify(ev.args, null, 2) : "Em execução…";
    } else {
      card.root.classList.remove("pending", "running");
      const ok = ev.ok !== false && !/^ERROR:/i.test(String(ev.preview || ev.result || ""));
      card.root.classList.toggle("ok", ok);
      card.root.classList.toggle("err", !ok);
      card.meta.textContent = ev.summary || (ok ? "ok" : "erro");
      card.detail.textContent = ev.preview || (ev.result ? String(ev.result).slice(0, 500) : "") || (ok ? "Concluído" : "Falhou");
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    if (btnSend) btnSend.disabled = v;
    if (btnStop) btnStop.classList.toggle("hidden", !v);
    if (!v) clearTransientStatus();
  }

  function hideApproval() {
    if (!approvalEl) return;
    approvalEl.classList.add("hidden");
    approvalEl.innerHTML = "";
  }

  function hideMentions() {
    mentionPopup.classList.add("hidden");
    mentionPopup.innerHTML = "";
    mentionItems = [];
    mentionIndex = 0;
    mentionQueryStart = -1;
  }

  function renderMentions() {
    mentionPopup.innerHTML = "";
    if (!mentionItems.length) { hideMentions(); return; }
    mentionPopup.classList.remove("hidden");
    mentionItems.forEach(function (item, i) {
      const prefix = item.kind === "folder" ? "📁 " : item.kind === "slash" ? "/ " : "📄 ";
      const row = el("div", "mention-item" + (i === mentionIndex ? " active" : ""), prefix + item.label);
      row.onclick = function () { applyMention(item); };
      mentionPopup.appendChild(row);
    });
  }

  function applyMention(item) {
    if (mentionQueryStart < 0) return;
    const before = input.value.slice(0, mentionQueryStart);
    const after = input.value.slice(input.selectionStart);
    let insert = item.insert || item.label || "";
    if (!insert.endsWith(" ")) insert += " ";
    input.value = before + insert + after;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    input.focus();
    hideMentions();
  }

  function detectMention() {
    const pos = input.selectionStart;
    const left = input.value.slice(0, pos);
    const slash = left.match(/(^|\s)\/([a-zA-Z0-9_-]*)$/);
    if (slash) {
      mentionQueryStart = pos - slash[2].length - 1;
      vscode.postMessage({ type: "listSlash", query: slash[2] });
      return;
    }
    const match = left.match(/(^|\s)@([^\s@]*)$/);
    if (!match) { hideMentions(); return; }
    mentionQueryStart = pos - match[2].length - 1;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(function () {
      vscode.postMessage({ type: "searchMentions", query: match[2] });
    }, 120);
  }

  function showApproval(payload) {
    approvalEl.classList.remove("hidden");
    approvalEl.innerHTML = "";
    const isDiff = Boolean(payload.diff);
    approvalEl.appendChild(el("div", "label", isDiff
      ? ("Diff — " + (payload.diff.isNew ? "criar" : "editar") + " " + payload.diff.path)
      : ("Aprovação — " + (payload.summary || payload.toolName))));
    const row = el("div", "row");
    const allow = el("button", "primary", isDiff ? "Aplicar" : "Permitir");
    const deny = el("button", "ghost", "Recusar");
    allow.onclick = function () {
      vscode.postMessage({ type: "approve", toolCallId: payload.toolCallId });
      hideApproval();
    };
    deny.onclick = function () {
      vscode.postMessage({ type: "deny", toolCallId: payload.toolCallId });
      hideApproval();
    };
    row.appendChild(allow); row.appendChild(deny);
    approvalEl.appendChild(row);
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    hideMentions();
    closeMenus();
    if (demo) {
      appendMessage("user", text, "Você");
      setBusy(true);
      setTransientStatus("Pensando…");
      setTimeout(function () {
        clearTransientStatus();
        appendMessage("assistant", "Demo visual — composer no estilo Continue (modo + modelos inline).", "Forge");
        setBusy(false);
      }, 550);
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: "send", text: text });
  }

  function renderDemo() {
    demo = true;
    if (btnDemo) btnDemo.setAttribute("aria-pressed", "true");
    messagesEl.innerHTML = "";
    toolCards.clear();
    streamNode = null;
    statusNode = null;
    models = DEMO_MODELS.slice();
    setMode("agent");
    setModelLabel("claude-sonnet-4");
    messagesEl.appendChild(el("div", "demo-banner", "Prévia visual"));
    appendMessage("user", "Quero o input no estilo Continue: modo com ícone e lista de modelos no composer.", "Você");
    const thinking = el("details", "msg thinking");
    thinking.appendChild(el("summary", null, "Pensando"));
    thinking.appendChild(el("div", "thinking-body", "Espelhando ModeSelect + ModelSelect do Continue."));
    messagesEl.appendChild(thinking);
    upsertToolCard({ toolCallId: "d1", toolName: "read_file", summary: "Read ModeSelect.tsx", args: { path: "ModeSelect.tsx" } }, "request");
    upsertToolCard({ toolCallId: "d1", toolName: "read_file", summary: "180 lines", preview: "export function ModeSelect() { … }", ok: true }, "result");
    appendRichAssistant([
      { type: "text", text: "Composer Continue-style:\n• Mode pill com submenu\n• Model pill com lista inline\n• Settings em folha sobre o chat\n\n" },
      { type: "code", text: "<ModeSelect /> <ModelSelect /> ⚙ overlay" },
    ]);
    if (contextStrip) contextStrip.classList.remove("hidden");
    if (usageEl) { usageEl.classList.remove("hidden"); usageEl.textContent = "tokens in 1.1k / out 740"; }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function exitDemo() {
    demo = false;
    if (btnDemo) btnDemo.setAttribute("aria-pressed", "false");
    if (contextStrip) contextStrip.classList.add("hidden");
    if (usageEl) usageEl.classList.add("hidden");
    closeSettingsOverlay();
    hideApproval();
    showEmpty();
  }

  function toggleDemo() {
    if (demo) exitDemo(); else renderDemo();
    closeMenus();
  }

  function cycleModeLocal() {
    const order = ["ask", "plan", "agent", "auto"];
    const next = order[(order.indexOf(autonomy) + 1) % order.length];
    setMode(next);
    if (!demo) vscode.postMessage({ type: "setAutonomy", mode: next });
  }

  btnSend.addEventListener("click", send);
  if (btnStop) btnStop.addEventListener("click", function () {
    if (demo) { setBusy(false); return; }
    vscode.postMessage({ type: "stop" });
  });
  if (btnNew) btnNew.addEventListener("click", function () {
    closeMenus();
    if (demo) { exitDemo(); return; }
    vscode.postMessage({ type: "newChat" });
  });
  if (btnMode) btnMode.addEventListener("click", toggleModeMenu);
  if (btnModel) btnModel.addEventListener("click", toggleModelMenu);
  if (modeMenu) modeMenu.addEventListener("click", function (e) {
    const item = e.target.closest(".pop-item[data-mode]");
    if (!item) return;
    e.stopPropagation();
    const mode = item.getAttribute("data-mode");
    setMode(mode);
    closeModeMenu();
    if (!demo) vscode.postMessage({ type: "setAutonomy", mode: mode });
  });
  if (btnComposerSettings) btnComposerSettings.addEventListener("click", function (e) {
    e.stopPropagation(); openSettingsOverlay();
  });
  if (btnModelSettings) btnModelSettings.addEventListener("click", function (e) {
    e.stopPropagation(); closeModelMenu(); openSettingsOverlay();
  });
  if (btnAddModel) btnAddModel.addEventListener("click", function (e) {
    e.stopPropagation(); closeModelMenu(); openSettingsOverlay();
  });
  if (btnCloseSettings) btnCloseSettings.addEventListener("click", closeSettingsOverlay);
  if (settingsOverlay) settingsOverlay.addEventListener("click", function (e) {
    if (e.target === settingsOverlay) closeSettingsOverlay();
  });
  if (btnSettingsProfiles) btnSettingsProfiles.addEventListener("click", function () {
    vscode.postMessage({ type: "manageProfiles" });
  });
  if (btnSettingsKey) btnSettingsKey.addEventListener("click", function () {
    vscode.postMessage({ type: "setApiKey" });
  });
  if (btnClearContext) btnClearContext.addEventListener("click", function () {
    if (contextStrip) contextStrip.classList.add("hidden");
  });
  if (btnDemo) btnDemo.addEventListener("click", toggleDemo);
  if (btnMenu) btnMenu.addEventListener("click", function (e) {
    e.stopPropagation();
    closeModeMenu(); closeModelMenu();
    if (!overflowMenu) return;
    const willOpen = overflowMenu.classList.contains("hidden");
    overflowMenu.classList.toggle("hidden", !willOpen);
    btnMenu.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
  if (overflowMenu) overflowMenu.addEventListener("click", function (e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    closeMenus();
    if (action === "demo") toggleDemo();
    if (action === "settings") openSettingsOverlay();
    if (action === "history") vscode.postMessage({ type: "listSessions" });
    if (action === "undo") vscode.postMessage({ type: "undoCheckpoint" });
  });

  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeMenus(); closeSettingsOverlay(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ".") { e.preventDefault(); cycleModeLocal(); }
  });

  input.addEventListener("input", detectMention);
  input.addEventListener("keydown", function (e) {
    if (!mentionPopup.classList.contains("hidden") && mentionItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; renderMentions(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; renderMentions(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionItems[mentionIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); hideMentions(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "config":
        setMode(msg.autonomy || msg.mode || autonomy);
        currentProvider = msg.provider || "";
        currentProfile = msg.profileName || "";
        if (typeof msg.hasKey === "boolean") hasKey = msg.hasKey;
        setModelLabel(msg.model || currentModel);
        if (Array.isArray(msg.models) && msg.models.length) { models = msg.models; renderModelList(); }
        break;
      case "models":
        models = msg.models || [];
        renderModelList();
        break;
      case "showSettings":
        openSettingsOverlay();
        break;
      case "user":
        if (!demo) appendMessage("user", msg.text, "Você");
        break;
      case "cleared":
        hideApproval(); hideMentions(); closeSettingsOverlay();
        if (demo) exitDemo(); else showEmpty();
        setBusy(false);
        break;
      case "error":
        appendMessage("error", msg.text, "Erro");
        setBusy(false);
        break;
      case "approval":
        showApproval(msg);
        break;
      case "sessions": {
        ensureList();
        const box = el("div", "msg plan");
        box.appendChild(el("div", "plan-title", "Histórico"));
        (msg.sessions || []).slice(0, 12).forEach(function (s) {
          const row = el("div", "row");
          const open = el("button", "ghost", s.title || s.id);
          open.onclick = function () { vscode.postMessage({ type: "loadSession", id: s.id }); };
          row.appendChild(open); box.appendChild(row);
        });
        messagesEl.appendChild(box);
        break;
      }
      case "slashSuggestions":
        mentionItems = (msg.suggestions || []).map(function (s) {
          return { label: "/" + (s.name || s.label || ""), kind: "slash", insert: s.insert || ("/" + (s.name || "") + " ") };
        });
        mentionIndex = 0; renderMentions();
        break;
      case "mentionSuggestions":
        mentionItems = (msg.suggestions || []).map(function (s) {
          return { label: s.label || s.path || s.name, kind: s.kind || "file", insert: s.insert || ("@" + (s.path || s.label || "") + " ") };
        });
        mentionIndex = 0; renderMentions();
        break;
      case "insertIntoComposer": {
        const t = String(msg.text || "");
        const start = input.selectionStart; const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + t + input.value.slice(end);
        input.setSelectionRange(start + t.length, start + t.length);
        input.focus();
        break;
      }
      case "agent": {
        if (demo) break;
        const ev = msg.event; if (!ev) break;
        if (ev.type === "status") {
          const text = String(ev.text || "");
          if (!/^Executando\b/i.test(text)) setTransientStatus(text);
        } else if (ev.type === "assistant_delta") {
          ensureList(); clearTransientStatus();
          if (!streamNode) streamNode = appendMessage("assistant", "", "Forge");
          (streamNode.querySelector(".body") || streamNode).appendChild(document.createTextNode(ev.text || ""));
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (ev.type === "assistant_done") {
          clearTransientStatus();
          if (streamNode) streamNode = null;
          else if (ev.text) appendMessage("assistant", ev.text || "", "Forge");
        } else if (ev.type === "usage" && usageEl && ev.usage) {
          usageEl.classList.remove("hidden");
          usageEl.textContent = "tokens in " + ev.usage.inputTokens + " / out " + ev.usage.outputTokens;
        } else if (ev.type === "tool_request") upsertToolCard(ev, "request");
        else if (ev.type === "tool_result") upsertToolCard(ev, "result");
        else if (ev.type === "error") { clearTransientStatus(); appendMessage("error", ev.text || "Erro", "Erro"); }
        else if (ev.type === "plan_ready") {
          clearTransientStatus(); ensureList();
          const box = el("div", "msg plan");
          box.appendChild(el("div", "plan-title", "Plano"));
          box.appendChild(document.createTextNode((ev.plan || ev.text || "").slice(0, 4000)));
          messagesEl.appendChild(box);
        } else if (ev.type === "done") {
          streamNode = null; clearTransientStatus(); setBusy(false); hideApproval();
        }
        break;
      }
      default: break;
    }
  });

  setMode("agent");
  showEmpty();
  vscode.postMessage({ type: "ready" });
})();
