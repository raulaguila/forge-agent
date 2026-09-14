(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const approval = document.getElementById("approval");
  const mentionPopup = document.getElementById("mentionPopup");
  const btnSend = document.getElementById("btnSend");
  const btnStop = document.getElementById("btnStop");
  const btnNew = document.getElementById("btnNew");
  const btnMode = document.getElementById("btnMode");
  const btnModel = document.getElementById("btnModel");
  const btnMenu = document.getElementById("btnMenu");
  const overflowMenu = document.getElementById("overflowMenu");
  const usageEl = document.getElementById("usage");

  let busy = false;
  let autonomy = "agent";
  let streamNode = null;
  let statusNode = null;
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionQueryStart = -1;
  let mentionTimer = null;
  const toolCards = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showEmpty() {
    messagesEl.innerHTML = "";
    toolCards.clear();
    statusNode = null;
    streamNode = null;
    const box = el("div", "empty");
    box.appendChild(el("h1", null, "Forge"));
    box.appendChild(
      el("p", null, "Pergunte qualquer coisa sobre o código. Use @arquivo ou /plan.")
    );
    messagesEl.appendChild(box);
  }

  function ensureList() {
    const empty = messagesEl.querySelector(".empty");
    if (empty) empty.remove();
  }

  function appendMessage(kind, text, label) {
    ensureList();
    const node = el("div", `msg ${kind}`);
    if (label) node.appendChild(el("span", "label", label));
    node.appendChild(document.createTextNode(text));
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return node;
  }

  function setTransientStatus(text) {
    ensureList();
    if (!text) {
      if (statusNode) {
        statusNode.remove();
        statusNode = null;
      }
      return;
    }
    if (!statusNode || !statusNode.isConnected) {
      statusNode = el("div", "msg status");
      messagesEl.appendChild(statusNode);
    }
    statusNode.textContent = text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearTransientStatus() {
    if (statusNode) {
      statusNode.remove();
      statusNode = null;
    }
  }

  function toolTitle(ev) {
    if (ev.summary) return ev.summary;
    const name = ev.toolName || "tool";
    const args = ev.args || {};
    if (args.path) return `${name} ${args.path}`;
    if (args.command) return `${name} ${args.command}`;
    if (args.pattern) return `${name} ${args.pattern}`;
    return name;
  }

  function upsertToolCard(ev, phase) {
    ensureList();
    clearTransientStatus();
    const id = ev.toolCallId || `${ev.toolName}-${Date.now()}`;
    let card = toolCards.get(id);
    if (!card) {
      card = el("div", "tool-card");
      card.dataset.id = id;

      const head = el("button", "tool-head");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");

      const chevron = el("span", "tool-chevron", "▸");
      const title = el("span", "tool-title", toolTitle(ev));
      const meta = el("span", "tool-meta", "");
      head.appendChild(chevron);
      head.appendChild(title);
      head.appendChild(meta);

      const body = el("div", "tool-body hidden");
      const detail = el("pre", "tool-detail");
      body.appendChild(detail);

      head.addEventListener("click", () => {
        const open = body.classList.toggle("hidden") === false;
        chevron.textContent = open ? "▾" : "▸";
        head.setAttribute("aria-expanded", open ? "true" : "false");
      });

      card.appendChild(head);
      card.appendChild(body);
      messagesEl.appendChild(card);
      toolCards.set(id, { root: card, title, meta, detail, body, chevron, head });
      card = toolCards.get(id);
    }

    card.title.textContent = toolTitle(ev);

    if (phase === "request") {
      card.root.classList.remove("ok", "err");
      card.root.classList.add(ev.requiresApproval ? "pending" : "running");
      card.meta.textContent = ev.requiresApproval ? "aguardando" : "…";
      const argsText =
        ev.args && Object.keys(ev.args).length
          ? JSON.stringify(ev.args, null, 2)
          : "";
      card.detail.textContent = argsText || "Em execução…";
    } else {
      card.root.classList.remove("pending", "running");
      const ok = ev.ok !== false && !/^ERROR:/i.test(String(ev.preview || ev.result || ""));
      card.root.classList.toggle("ok", ok);
      card.root.classList.toggle("err", !ok);
      card.meta.textContent = ev.summary || (ok ? "ok" : "erro");
      card.detail.textContent =
        ev.preview ||
        (ev.result ? String(ev.result).slice(0, 500) : "") ||
        (ok ? "Concluído" : "Falhou");
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
    return card;
  }

  function setBusy(v) {
    busy = v;
    btnSend.disabled = v;
    if (btnStop) {
      btnStop.classList.toggle("hidden", !v);
    }
    if (!v) {
      clearTransientStatus();
    }
  }

  function shortLabel(text, max) {
    const t = String(text || "");
    const limit = max || 18;
    return t.length > limit ? t.slice(0, limit - 1) + "…" : t;
  }

  function setMode(mode) {
    autonomy = mode || "agent";
    if (btnMode) {
      btnMode.textContent = autonomy;
      btnMode.dataset.mode = autonomy;
    }
  }

  function closeMenu() {
    if (!overflowMenu || !btnMenu) return;
    overflowMenu.classList.add("hidden");
    btnMenu.setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    if (!overflowMenu || !btnMenu) return;
    const open = overflowMenu.classList.contains("hidden");
    overflowMenu.classList.toggle("hidden", !open);
    btnMenu.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function hideApproval() {
    approval.classList.add("hidden");
    approval.innerHTML = "";
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
    if (!mentionItems.length) {
      hideMentions();
      return;
    }
    mentionPopup.classList.remove("hidden");
    mentionItems.forEach((item, i) => {
      const row = el(
        "div",
        "mention-item" + (i === mentionIndex ? " active" : ""),
        `${item.kind === "folder" ? "📁 " : item.kind === "file" ? "📄 " : "✦ "}${item.label}`
      );
      row.onclick = () => applyMention(item);
      mentionPopup.appendChild(row);
    });
  }

  function applyMention(item) {
    if (mentionQueryStart < 0) return;
    const before = input.value.slice(0, mentionQueryStart);
    const afterCursor = input.value.slice(input.selectionStart);
    // remove partial @query
    const insert = item.insert.endsWith(" ") ? item.insert : item.insert + " ";
    input.value = before + insert + afterCursor;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    input.focus();
    hideMentions();
  }

  function detectSlash() {
    const pos = input.selectionStart;
    const left = input.value.slice(0, pos);
    const match = left.match(/(^|[\s])\/([a-zA-Z0-9_-]*)$/);
    if (!match) return false;
    mentionQueryStart = pos - match[2].length - 1;
    vscode.postMessage({ type: "listSlash", query: match[2] });
    return true;
  }

  function detectMention() {
    if (detectSlash()) return;

    const pos = input.selectionStart;
    const left = input.value.slice(0, pos);
    const match = left.match(/(^|[\s])@([^\s@]*)$/);
    if (!match) {
      hideMentions();
      return;
    }
    mentionQueryStart = pos - match[2].length - 1;
    const query = match[2];
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => {
      vscode.postMessage({ type: "searchMentions", query });
    }, 120);
  }

  function showApproval(payload) {
    approval.classList.remove("hidden");
    approval.innerHTML = "";
    const isDiff = Boolean(payload.diff);
    approval.appendChild(
      el(
        "div",
        "label",
        isDiff
          ? `Diff — ${payload.diff.isNew ? "criar" : "editar"} ${payload.diff.path}`
          : `Aprovação — ${payload.summary || payload.toolName} (${payload.risk})`
      )
    );
    if (isDiff) {
      approval.appendChild(
        el(
          "p",
          "hint",
          `Revise o diff aberto no editor (${payload.diff.bytes} bytes) e confirme.`
        )
      );
    } else if (payload.args && Object.keys(payload.args).length) {
      const pre = el("pre");
      pre.textContent = JSON.stringify(payload.args, null, 2);
      approval.appendChild(pre);
    }
    const row = el("div", "row");
    const allow = el("button", "primary", isDiff ? "Aplicar" : "Permitir");
    const deny = el("button", "ghost", "Recusar");
    allow.onclick = () => {
      vscode.postMessage({ type: "approve", toolCallId: payload.toolCallId });
      hideApproval();
    };
    deny.onclick = () => {
      vscode.postMessage({ type: "deny", toolCallId: payload.toolCallId });
      hideApproval();
    };
    row.appendChild(allow);
    row.appendChild(deny);
    approval.appendChild(row);
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    hideMentions();
    setBusy(true);
    vscode.postMessage({ type: "send", text });
  }

  btnSend.addEventListener("click", send);
  if (btnStop) {
    btnStop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  }
  if (btnNew) {
    btnNew.addEventListener("click", () => {
      closeMenu();
      vscode.postMessage({ type: "newChat" });
    });
  }
  if (btnMode) {
    btnMode.addEventListener("click", () =>
      vscode.postMessage({ type: "cycleAutonomy" })
    );
  }
  if (btnModel) {
    btnModel.addEventListener("click", () =>
      vscode.postMessage({ type: "openSettings" })
    );
  }
  if (btnMenu) {
    btnMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  }
  if (overflowMenu) {
    overflowMenu.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      closeMenu();
      if (action === "settings") vscode.postMessage({ type: "openSettings" });
      if (action === "history") vscode.postMessage({ type: "listSessions" });
      if (action === "undo") vscode.postMessage({ type: "undoCheckpoint" });
    });
  }
  document.addEventListener("click", () => closeMenu());

  input.addEventListener("input", detectMention);
  input.addEventListener("keydown", (e) => {
    if (!mentionPopup.classList.contains("hidden") && mentionItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionIndex = (mentionIndex + 1) % mentionItems.length;
        renderMentions();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
        renderMentions();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionItems[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentions();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "config":
        setMode(msg.autonomy);
        if (btnModel) {
          const label = shortLabel(msg.model || "modelo", 22);
          btnModel.textContent = label;
          btnModel.title = `${msg.profileName || msg.provider} · ${msg.model}${
            msg.hasKey ? "" : " · sem key"
          }`;
        }
        break;
      case "user":
        appendMessage("user", msg.text, "Você");
        break;
      case "cleared":
        hideApproval();
        hideMentions();
        showEmpty();
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
        const box = el("div", "msg tool");
        box.appendChild(el("span", "label", "Histórico"));
        const list = msg.sessions || [];
        if (!list.length) {
          box.appendChild(document.createTextNode("Nenhuma sessão salva."));
        } else {
          list.slice(0, 12).forEach((s) => {
            const row = el("div", "row");
            const open = el("button", "ghost", s.title || s.id);
            open.onclick = () => vscode.postMessage({ type: "loadSession", id: s.id });
            const del = el("button", "ghost danger", "×");
            del.onclick = () => vscode.postMessage({ type: "deleteSession", id: s.id });
            row.appendChild(open);
            row.appendChild(del);
            box.appendChild(row);
          });
        }
        messagesEl.appendChild(box);
        break;
      }
      case "slashSuggestions": {
        if (mentionQueryStart < 0) {
          mentionQueryStart = input.value.lastIndexOf("/");
        }
        mentionItems = (msg.suggestions || []).map((s) => ({
          label: "/" + s.name + " — " + s.description,
          kind: "active",
          insert: s.insert,
        }));
        mentionIndex = 0;
        renderMentions();
        break;
      }
      case "mentionSuggestions":
        mentionItems = msg.suggestions || [];
        mentionIndex = 0;
        renderMentions();
        break;
      case "insertIntoComposer": {
        const t = String(msg.text || "");
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + t + input.value.slice(end);
        const pos = start + t.length;
        input.setSelectionRange(pos, pos);
        input.focus();
        break;
      }
      case "agent": {
        const ev = msg.event;
        if (!ev) break;
        if (ev.type === "status") {
          const text = String(ev.text || "");
          if (/^Executando\b/i.test(text)) {
            break;
          }
          setTransientStatus(text);
        } else if (ev.type === "assistant_delta") {
          ensureList();
          clearTransientStatus();
          if (!streamNode) {
            streamNode = appendMessage("assistant", "", "Forge");
          }
          streamNode.appendChild(document.createTextNode(ev.text || ""));
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (ev.type === "assistant_done") {
          clearTransientStatus();
          if (streamNode) {
            streamNode = null;
          } else if (ev.text) {
            appendMessage("assistant", ev.text || "", "Forge");
          }
        } else if (ev.type === "usage") {
          if (usageEl && ev.usage) {
            const u = ev.usage;
            usageEl.classList.remove("hidden");
            const cost = u.estimatedCostUsd != null ? ` · ~$${Number(u.estimatedCostUsd).toFixed(4)}` : "";
            usageEl.textContent = `tokens in ${u.inputTokens} / out ${u.outputTokens} (Σ ${u.totalTokens})${cost}`;
          }
        } else if (ev.type === "diff_proposal") {
          const d = ev.diff;
          upsertToolCard(
            {
              toolCallId: ev.toolCallId || `diff-${ev.toolName}`,
              toolName: ev.toolName,
              summary: d
                ? `${d.isNew ? "Create" : "Edit"} ${d.path}`
                : ev.summary || ev.toolName || "Diff",
              args: d
                ? { path: d.path, isNew: d.isNew, bytes: d.newContent ? d.newContent.length : undefined }
                : ev.args,
              requiresApproval: ev.requiresApproval,
            },
            "request"
          );
        } else if (ev.type === "tool_request") {
          upsertToolCard(ev, "request");
        } else if (ev.type === "tool_result") {
          upsertToolCard(ev, "result");
        } else if (ev.type === "error") {
          clearTransientStatus();
          appendMessage("error", ev.text || "Erro", "Erro");
        } else if (ev.type === "plan_ready") {
          clearTransientStatus();
          ensureList();
          const box = el("div", "msg plan");
          box.appendChild(el("span", "label", "Plano"));
          box.appendChild(document.createTextNode((ev.plan || ev.text || "").slice(0, 4000)));
          const row = el("div", "row");
          const btn = el("button", "primary", "Executar plano");
          btn.onclick = () => {
            vscode.postMessage({ type: "executePlan", plan: ev.plan || ev.text || "" });
          };
          row.appendChild(btn);
          box.appendChild(row);
          messagesEl.appendChild(box);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (ev.type === "done") {
          streamNode = null;
          clearTransientStatus();
          setBusy(false);
          hideApproval();
        }
        break;
      }
      default:
        break;
    }
  });

  showEmpty();
  vscode.postMessage({ type: "ready" });
})();
