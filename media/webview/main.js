(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const approvalEl = document.getElementById("approval");
  const usageEl = document.getElementById("usage");
  const mentionPopup = document.getElementById("mentionPopup");
  const contextStrip = document.getElementById("contextStrip");
  const overflowMenu = document.getElementById("overflowMenu");

  const btnSend = document.getElementById("btnSend");
  const btnStop = document.getElementById("btnStop");
  const btnNew = document.getElementById("btnNew");
  const btnMode = document.getElementById("btnMode");
  const btnModel = document.getElementById("btnModel");
  const btnMenu = document.getElementById("btnMenu");
  const btnDemo = document.getElementById("btnDemo");
  const btnSlash = document.getElementById("btnSlash");
  const btnAttach = document.getElementById("btnAttach");
  const btnClearContext = document.getElementById("btnClearContext");

  let busy = false;
  let demo = false;
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
    box.appendChild(
      el("p", null, "Peça uma mudança, investigue um bug ou planeje um refactor.")
    );

    const list = el("div", "empty-suggestions");
    [
      {
        title: "Explicar este arquivo",
        sub: "Resuma responsabilidades e riscos",
        prompt: "Explique o arquivo atual: o que faz, riscos e como testar.",
      },
      {
        title: "Encontrar e corrigir um bug",
        sub: "Investigue com tools e proponha o patch",
        prompt: "Investigue o erro mais recente e proponha uma correção mínima.",
      },
      {
        title: "Planejar um refactor",
        sub: "Modo plan · sem editar ainda",
        prompt: "/plan Refatore o módulo principal para ficar mais testável.",
      },
    ].forEach((s) => {
      const btn = el("button", "suggestion");
      btn.type = "button";
      btn.appendChild(el("span", "s-title", s.title));
      btn.appendChild(el("span", "s-sub", s.sub));
      btn.addEventListener("click", () => {
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
    const node = el("div", `msg ${kind}`);
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
    parts.forEach((p) => {
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
      if (statusNode) {
        statusNode.remove();
        statusNode = null;
      }
      return;
    }
    if (!statusNode || !statusNode.isConnected) {
      statusNode = el("div", "msg status");
      statusNode.appendChild(el("span", "pulse"));
      statusNode.appendChild(document.createTextNode(""));
      messagesEl.appendChild(statusNode);
    }
    if (statusNode.childNodes[1]) {
      statusNode.childNodes[1].textContent = " " + text;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearTransientStatus() {
    if (statusNode) {
      statusNode.remove();
      statusNode = null;
    }
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
    const id = ev.toolCallId || ev.toolName + "-" + Date.now();
    let card = toolCards.get(id);

    if (!card) {
      const root = el("div", "tool-card");
      root.dataset.id = id;

      const head = el("button", "tool-head");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");

      const chevron = el("span", "tool-chevron", "▸");
      const icon = el("span", "tool-icon", toolIcon(ev.toolName));
      const title = el("span", "tool-title", toolTitle(ev));
      const meta = el("span", "tool-meta", "");
      head.appendChild(chevron);
      head.appendChild(icon);
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

      root.appendChild(head);
      root.appendChild(body);
      messagesEl.appendChild(root);
      toolCards.set(id, { root: root, title: title, meta: meta, detail: detail, body: body, chevron: chevron, icon: icon });
      card = toolCards.get(id);
    }

    card.title.textContent = toolTitle(ev);
    card.icon.textContent = toolIcon(ev.toolName);

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
      const ok =
        ev.ok !== false && !/^ERROR:/i.test(String(ev.preview || ev.result || ""));
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
    if (btnSend) btnSend.disabled = v;
    if (btnStop) btnStop.classList.toggle("hidden", !v);
    if (!v) clearTransientStatus();
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
    const willOpen = overflowMenu.classList.contains("hidden");
    overflowMenu.classList.toggle("hidden", !willOpen);
    btnMenu.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function hideApproval() {
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
    if (!mentionItems.length) {
      hideMentions();
      return;
    }
    mentionPopup.classList.remove("hidden");
    mentionItems.forEach((item, i) => {
      const prefix =
        item.kind === "folder" ? "📁 " : item.kind === "slash" ? "/ " : "📄 ";
      const row = el(
        "div",
        "mention-item" + (i === mentionIndex ? " active" : ""),
        prefix + item.label
      );
      row.onclick = function () {
        applyMention(item);
      };
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
    if (!match) {
      hideMentions();
      return;
    }
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
    approvalEl.appendChild(
      el(
        "div",
        "label",
        isDiff
          ? "Diff — " + (payload.diff.isNew ? "criar" : "editar") + " " + payload.diff.path
          : "Aprovação — " + (payload.summary || payload.toolName) + " (" + (payload.risk || "write") + ")"
      )
    );
    if (isDiff) {
      approvalEl.appendChild(
        el(
          "p",
          "hint",
          "Revise o diff no editor (" + (payload.diff.bytes || "?") + " bytes) e confirme."
        )
      );
    } else if (payload.args && Object.keys(payload.args).length) {
      const pre = el("pre");
      pre.textContent = JSON.stringify(payload.args, null, 2);
      approvalEl.appendChild(pre);
    }
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
    row.appendChild(allow);
    row.appendChild(deny);
    approvalEl.appendChild(row);
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    hideMentions();

    if (demo) {
      appendMessage("user", text, "Você");
      setBusy(true);
      setTransientStatus("Pensando…");
      setTimeout(function () {
        clearTransientStatus();
        appendMessage(
          "assistant",
          "Demo visual — a resposta real do agent entra depois. O layout já mostra como a conversa deve respirar.",
          "Forge"
        );
        setBusy(false);
      }, 650);
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

    messagesEl.appendChild(el("div", "demo-banner", "Prévia visual"));

    appendMessage(
      "user",
      "O header do chat está poluído. Deixa mais parecido com Claude/Codex e resume as tools.",
      "Você"
    );

    const thinking = el("details", "msg thinking");
    thinking.open = false;
    thinking.appendChild(el("summary", null, "Pensando"));
    thinking.appendChild(
      el(
        "div",
        "thinking-body",
        "Vou inspecionar o HTML do webview e o CSS do composer, depois colapsar a saída das tools."
      )
    );
    messagesEl.appendChild(thinking);

    upsertToolCard(
      {
        toolCallId: "demo-1",
        toolName: "read_file",
        summary: "Read src/webview/ChatViewProvider.ts",
        args: { path: "src/webview/ChatViewProvider.ts" },
      },
      "request"
    );
    upsertToolCard(
      {
        toolCallId: "demo-1",
        toolName: "read_file",
        summary: "420 lines · 18k chars",
        preview: "export class ChatViewProvider …\n  getHtml() { … }",
        ok: true,
      },
      "result"
    );

    upsertToolCard(
      {
        toolCallId: "demo-2",
        toolName: "run_terminal",
        summary: "Ran npm test",
        args: { command: "npm test" },
      },
      "request"
    );
    upsertToolCard(
      {
        toolCallId: "demo-2",
        toolName: "run_terminal",
        summary: "exit 0 · 24 lines",
        preview: "PASS  media/webview\n  ✓ empty state\n  ✓ tool cards collapsed",
        ok: true,
      },
      "result"
    );

    appendRichAssistant([
      {
        type: "text",
        text:
          "Pronto — o chrome ficou mínimo e as tools viraram linhas colapsáveis.\n\nNo composer você tem modo, modelo e um medidor de contexto. O conteúdo das tools só aparece se expandir.\n\n",
      },
      {
        type: "code",
        text: ".tool-card { /* uma linha */ }\n.composer-card { /* centro da UI */ }",
      },
    ]);

    const plan = el("div", "msg plan");
    plan.appendChild(el("div", "plan-title", "Plano"));
    const ol = document.createElement("ol");
    ["Shell + empty state", "Transcript tipográfico", "Overlays (histórico / aprovação)"].forEach(
      function (step) {
        const li = document.createElement("li");
        li.textContent = step;
        ol.appendChild(li);
      }
    );
    plan.appendChild(ol);
    const row = el("div", "row");
    row.appendChild(el("button", "primary", "Executar plano"));
    row.appendChild(el("button", "ghost", "Editar"));
    plan.appendChild(row);
    messagesEl.appendChild(plan);

    if (contextStrip) contextStrip.classList.remove("hidden");
    if (usageEl) {
      usageEl.classList.remove("hidden");
      usageEl.textContent = "tokens in 1.2k / out 860 · ~$0.014";
    }
    setMode("agent");
    if (btnModel) {
      btnModel.textContent = "claude-sonnet";
      btnModel.title = "anthropic · claude-sonnet-4";
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function exitDemo() {
    demo = false;
    if (btnDemo) btnDemo.setAttribute("aria-pressed", "false");
    if (contextStrip) contextStrip.classList.add("hidden");
    if (usageEl) usageEl.classList.add("hidden");
    hideApproval();
    showEmpty();
  }

  function toggleDemo() {
    if (demo) exitDemo();
    else renderDemo();
    closeMenu();
  }

  btnSend.addEventListener("click", send);
  if (btnStop) {
    btnStop.addEventListener("click", function () {
      if (demo) {
        setBusy(false);
        return;
      }
      vscode.postMessage({ type: "stop" });
    });
  }
  if (btnNew) {
    btnNew.addEventListener("click", function () {
      closeMenu();
      if (demo) {
        exitDemo();
        return;
      }
      vscode.postMessage({ type: "newChat" });
    });
  }
  if (btnMode) {
    btnMode.addEventListener("click", function () {
      if (demo) {
        const modes = ["ask", "plan", "agent", "auto"];
        setMode(modes[(modes.indexOf(autonomy) + 1) % modes.length]);
        return;
      }
      vscode.postMessage({ type: "cycleAutonomy" });
    });
  }
  if (btnModel) {
    btnModel.addEventListener("click", function () {
      vscode.postMessage({ type: "openSettings" });
    });
  }
  if (btnSlash) {
    btnSlash.addEventListener("click", function () {
      input.value = (input.value ? input.value + " " : "") + "/";
      input.focus();
      detectMention();
    });
  }
  if (btnAttach) {
    btnAttach.addEventListener("click", function () {
      if (contextStrip) contextStrip.classList.toggle("hidden");
    });
  }
  if (btnClearContext) {
    btnClearContext.addEventListener("click", function () {
      if (contextStrip) contextStrip.classList.add("hidden");
    });
  }
  if (btnDemo) btnDemo.addEventListener("click", toggleDemo);
  if (btnMenu) {
    btnMenu.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMenu();
    });
  }
  if (overflowMenu) {
    overflowMenu.addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      closeMenu();
      if (action === "demo") toggleDemo();
      if (action === "settings") vscode.postMessage({ type: "openSettings" });
      if (action === "history") vscode.postMessage({ type: "listSessions" });
      if (action === "undo") vscode.postMessage({ type: "undoCheckpoint" });
    });
  }
  document.addEventListener("click", function () {
    closeMenu();
  });

  input.addEventListener("input", detectMention);
  input.addEventListener("keydown", function (e) {
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

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "config":
        setMode(msg.autonomy || msg.mode || autonomy);
        if (btnModel) {
          btnModel.textContent = shortLabel(msg.model || "modelo", 22);
          btnModel.title =
            (msg.profileName || msg.provider || "provider") +
            " · " +
            (msg.model || "") +
            (msg.hasKey === false ? " · sem key" : "");
        }
        break;
      case "user":
        if (!demo) appendMessage("user", msg.text, "Você");
        break;
      case "cleared":
        hideApproval();
        hideMentions();
        if (demo) exitDemo();
        else showEmpty();
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
        const list = msg.sessions || [];
        if (!list.length) {
          box.appendChild(document.createTextNode("Nenhuma sessão salva."));
        } else {
          list.slice(0, 12).forEach(function (s) {
            const row = el("div", "row");
            const open = el("button", "ghost", s.title || s.id);
            open.onclick = function () {
              vscode.postMessage({ type: "loadSession", id: s.id });
            };
            const del = el("button", "ghost", "×");
            del.onclick = function () {
              vscode.postMessage({ type: "deleteSession", id: s.id });
            };
            row.appendChild(open);
            row.appendChild(del);
            box.appendChild(row);
          });
        }
        messagesEl.appendChild(box);
        break;
      }
      case "slashSuggestions":
        mentionItems = (msg.suggestions || []).map(function (s) {
          return {
            label: "/" + (s.name || s.label || ""),
            kind: "slash",
            insert: s.insert || "/" + (s.name || "") + " ",
          };
        });
        mentionIndex = 0;
        renderMentions();
        break;
      case "mentionSuggestions":
        mentionItems = (msg.suggestions || []).map(function (s) {
          return {
            label: s.label || s.path || s.name,
            kind: s.kind || s.type || "file",
            insert: s.insert || "@" + (s.path || s.label || "") + " ",
          };
        });
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
        if (demo) break;
        const ev = msg.event;
        if (!ev) break;
        if (ev.type === "status") {
          const text = String(ev.text || "");
          if (/^Executando\b/i.test(text)) break;
          setTransientStatus(text);
        } else if (ev.type === "assistant_delta") {
          ensureList();
          clearTransientStatus();
          if (!streamNode) streamNode = appendMessage("assistant", "", "Forge");
          const body = streamNode.querySelector(".body") || streamNode;
          body.appendChild(document.createTextNode(ev.text || ""));
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (ev.type === "assistant_done") {
          clearTransientStatus();
          if (streamNode) streamNode = null;
          else if (ev.text) appendMessage("assistant", ev.text || "", "Forge");
        } else if (ev.type === "usage") {
          if (usageEl && ev.usage) {
            const u = ev.usage;
            usageEl.classList.remove("hidden");
            const cost =
              u.estimatedCostUsd != null
                ? " · ~$" + Number(u.estimatedCostUsd).toFixed(4)
                : "";
            usageEl.textContent =
              "tokens in " +
              u.inputTokens +
              " / out " +
              u.outputTokens +
              " (Σ " +
              u.totalTokens +
              ")" +
              cost;
          }
        } else if (ev.type === "diff_proposal") {
          const d = ev.diff;
          upsertToolCard(
            {
              toolCallId: ev.toolCallId || "diff-" + ev.toolName,
              toolName: ev.toolName,
              summary: d
                ? (d.isNew ? "Create " : "Edit ") + d.path
                : ev.summary || ev.toolName || "Diff",
              args: d ? { path: d.path, isNew: d.isNew } : ev.args,
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
          box.appendChild(el("div", "plan-title", "Plano"));
          box.appendChild(
            document.createTextNode((ev.plan || ev.text || "").slice(0, 4000))
          );
          const row = el("div", "row");
          const btn = el("button", "primary", "Executar plano");
          btn.onclick = function () {
            vscode.postMessage({
              type: "executePlan",
              plan: ev.plan || ev.text || "",
            });
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
