(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const meta = document.getElementById("meta");
  const approval = document.getElementById("approval");
  const btnSend = document.getElementById("btnSend");
  const btnStop = document.getElementById("btnStop");
  const btnNew = document.getElementById("btnNew");
  const btnKey = document.getElementById("btnKey");
  const btnMode = document.getElementById("btnMode");

  let busy = false;
  let autonomy = "agent";

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
        "Agentic coding com a sua chave. Peça para implementar features, corrigir bugs ou refatorar — o agent lê, edita e roda comandos no workspace."
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
      btnMode.title = "Modo: " + autonomy + " (clique para ciclar ask/agent/auto)";
    }
  }

  function hideApproval() {
    approval.classList.add("hidden");
    approval.innerHTML = "";
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
  input.addEventListener("keydown", (e) => {
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
      case "agent": {
        const ev = msg.event;
        if (!ev) break;
        if (ev.type === "status") {
          appendMessage("status", ev.text || "");
        } else if (ev.type === "assistant_done") {
          appendMessage("assistant", ev.text || "", "Forge");
        } else if (ev.type === "diff_proposal") {
          const d = ev.diff;
          appendMessage(
            "tool",
            d
              ? `${d.isNew ? "criar" : "editar"} ${d.path}`
              : ev.toolName || "diff",
            "Diff"
          );
        } else if (ev.type === "tool_request") {
          appendMessage(
            "tool",
            `${ev.toolName} ${JSON.stringify(ev.args ?? {})}`,
            ev.requiresApproval ? "Tool (aguardando)" : "Tool"
          );
        } else if (ev.type === "tool_result") {
          const preview = (ev.result || "").slice(0, 1200);
          appendMessage("tool", preview, `${ev.toolName} →`);
        } else if (ev.type === "error") {
          appendMessage("error", ev.text || "Erro", "Erro");
        } else if (ev.type === "done") {
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
