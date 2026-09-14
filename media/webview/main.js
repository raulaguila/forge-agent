(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const meta = document.getElementById("meta");
  const approval = document.getElementById("approval");
  const mentionPopup = document.getElementById("mentionPopup");
  const btnSend = document.getElementById("btnSend");
  const btnStop = document.getElementById("btnStop");
  const btnNew = document.getElementById("btnNew");
  const btnKey = document.getElementById("btnKey");
  const btnMode = document.getElementById("btnMode");

  let busy = false;
  let autonomy = "agent";
  let streamNode = null;
  const usageEl = document.getElementById("usage");
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionQueryStart = -1;
  let mentionTimer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showEmpty() {
    messagesEl.innerHTML = "";
    const box = el("div", "empty");
    box.appendChild(el("h1", null, "Forge Agent"));
    box.appendChild(
      el(
        "p",
        null,
        "Use @arquivo, @pasta/, @selection ou @active para anexar contexto. Atalhos: Ctrl+Shift+I (chat), Ctrl+Shift+L (add seleção)."
      )
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

  function setBusy(v) {
    busy = v;
    btnSend.disabled = v;
  }

  function setMode(mode) {
    autonomy = mode || "agent";
    if (btnMode) {
      btnMode.textContent = autonomy;
      btnMode.dataset.mode = autonomy;
    }
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

  function detectMention() {
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
          : `Aprovação — ${payload.toolName} (${payload.risk})`
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
    } else {
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
  btnStop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  btnNew.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
  btnKey.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
  if (btnMode) {
    btnMode.addEventListener("click", () =>
      vscode.postMessage({ type: "cycleAutonomy" })
    );
  }

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
        meta.textContent = `${msg.provider} · ${msg.model} · ${msg.autonomy || "agent"}${
          msg.hasKey ? "" : " · sem key"
        }`;
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
          appendMessage("status", ev.text || "");
        } else if (ev.type === "assistant_delta") {
          ensureList();
          if (!streamNode) {
            streamNode = appendMessage("assistant", "", "Forge");
          }
          streamNode.appendChild(document.createTextNode(ev.text || ""));
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (ev.type === "assistant_done") {
          if (streamNode) {
            // streamed already; just finalize
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
          appendMessage(
            "tool",
            d ? `${d.isNew ? "criar" : "editar"} ${d.path}` : ev.toolName || "diff",
            "Diff"
          );
        } else if (ev.type === "tool_request") {
          appendMessage(
            "tool",
            `${ev.toolName} ${JSON.stringify(ev.args ?? {})}`,
            ev.requiresApproval ? "Tool (aguardando)" : "Tool"
          );
        } else if (ev.type === "tool_result") {
          appendMessage("tool", (ev.result || "").slice(0, 1200), `${ev.toolName} →`);
        } else if (ev.type === "error") {
          appendMessage("error", ev.text || "Erro", "Erro");
        } else if (ev.type === "done") {
          streamNode = null;
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
