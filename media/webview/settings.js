(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const els = {
    profileList: $("profileList"),
    profileForm: $("profileForm"),
    agentForm: $("agentForm"),
    profileId: $("profileId"),
    profileTitle: $("profileTitle"),
    name: $("name"),
    provider: $("provider"),
    model: $("model"),
    baseUrl: $("baseUrl"),
    tlsInsecure: $("tlsInsecure"),
    apiKey: $("apiKey"),
    keyStatus: $("keyStatus"),
    modelPicker: $("modelPicker"),
    autonomy: $("autonomy"),
    maxToolRounds: $("maxToolRounds"),
    temperature: $("temperature"),
    autoApproveReads: $("autoApproveReads"),
    requireApprovalForWrites: $("requireApprovalForWrites"),
    requireApprovalForTerminal: $("requireApprovalForTerminal"),
    systemPromptExtra: $("systemPromptExtra"),
    toast: $("toast"),
    btnNewProfile: $("btnNewProfile"),
    btnListModels: $("btnListModels"),
    btnActivate: $("btnActivate"),
    btnClearKey: $("btnClearKey"),
    btnDeleteProfile: $("btnDeleteProfile"),
    btnOpenRules: $("btnOpenRules"),
    btnSaveProfile: $("btnSaveProfile"),
  };

  let state = { providers: [], profiles: [], activeProfileId: null, agent: {} };
  let mode = "edit";
  let selectedId = null;
  let toastTimer = null;

  function showToast(text, level) {
    els.toast.textContent = text || "";
    els.toast.classList.remove("hidden", "ok", "error");
    els.toast.classList.add(level === "error" ? "error" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
  }

  function fillProviders() {
    els.provider.innerHTML = "";
    (state.providers || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      els.provider.appendChild(opt);
    });
  }

  function renderProfileList() {
    els.profileList.innerHTML = "";
    (state.profiles || []).forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "profile-item";
      if (p.id === selectedId || p.id === state.activeProfileId) {
        btn.classList.add("active");
      }
      const title = document.createElement("span");
      title.className = "name";
      title.textContent = p.name + (p.id === state.activeProfileId ? " · ativo" : "");
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent =
        p.provider +
        " · " +
        p.model +
        (p.requiresKey && !p.hasKey ? " · sem key" : "");
      btn.appendChild(title);
      btn.appendChild(meta);
      btn.addEventListener("click", () => {
        mode = "edit";
        selectedId = p.id;
        fillProfileForm(p);
        renderProfileList();
      });
      els.profileList.appendChild(btn);
    });
  }

  function fillProfileForm(p) {
    els.profileTitle.textContent = mode === "create" ? "Novo perfil" : "Perfil";
    els.profileId.value = p?.id || "";
    els.name.value = p?.name || "";
    els.provider.value = p?.provider || "openai";
    els.model.value = p?.model || "";
    els.baseUrl.value = p?.baseUrl || "";
    els.tlsInsecure.checked = Boolean(p?.tlsInsecure);
    els.apiKey.value = "";
    if (!p) els.keyStatus.textContent = "";
    else if (!p.requiresKey) els.keyStatus.textContent = "(opcional)";
    else els.keyStatus.textContent = p.hasKey ? "· configurada" : "· ausente";
    els.modelPicker.classList.add("hidden");
    els.modelPicker.innerHTML = "";
    els.btnDeleteProfile.disabled = mode === "create" || state.profiles.length <= 1;
    els.btnActivate.disabled = mode === "create";
    els.btnClearKey.disabled = mode === "create" || !p?.hasKey;
    els.btnSaveProfile.textContent = mode === "create" ? "Criar perfil" : "Salvar perfil";
  }

  function fillAgentForm(agent) {
    els.autonomy.value = agent.autonomy || "agent";
    els.maxToolRounds.value = agent.maxToolRounds ?? 25;
    els.temperature.value = agent.temperature ?? 0.2;
    els.autoApproveReads.checked = Boolean(agent.autoApproveReads);
    els.requireApprovalForWrites.checked = Boolean(agent.requireApprovalForWrites);
    els.requireApprovalForTerminal.checked = Boolean(agent.requireApprovalForTerminal);
    els.systemPromptExtra.value = agent.systemPromptExtra || "";
  }

  function profilePayload() {
    return {
      id: els.profileId.value,
      name: els.name.value,
      provider: els.provider.value,
      model: els.model.value,
      baseUrl: els.baseUrl.value,
      tlsInsecure: els.tlsInsecure.checked,
      apiKey: els.apiKey.value,
    };
  }

  function startCreate() {
    mode = "create";
    selectedId = null;
    fillProfileForm({
      id: "",
      name: "Novo perfil",
      provider: "openai",
      model: "",
      baseUrl: "",
      tlsInsecure: false,
      hasKey: false,
      requiresKey: true,
    });
    renderProfileList();
    vscode.postMessage({ type: "defaultsForProvider", provider: "openai" });
  }

  els.btnNewProfile.addEventListener("click", startCreate);
  els.provider.addEventListener("change", () => {
    vscode.postMessage({ type: "defaultsForProvider", provider: els.provider.value });
  });

  els.profileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = profilePayload();
    if (mode === "create" || !payload.id) {
      vscode.postMessage({ type: "createProfile", ...payload });
    } else {
      vscode.postMessage({ type: "saveProfile", ...payload });
    }
  });

  els.btnActivate.addEventListener("click", () => {
    if (!els.profileId.value) return;
    vscode.postMessage({ type: "selectProfile", id: els.profileId.value });
  });
  els.btnClearKey.addEventListener("click", () => {
    if (!els.profileId.value) return;
    vscode.postMessage({ type: "clearApiKey", id: els.profileId.value });
  });
  els.btnDeleteProfile.addEventListener("click", () => {
    if (!els.profileId.value) return;
    vscode.postMessage({ type: "deleteProfile", id: els.profileId.value });
  });
  els.btnListModels.addEventListener("click", () => {
    const id = els.profileId.value || state.activeProfileId;
    if (!id) {
      showToast("Salve o perfil antes de listar modelos.", "error");
      return;
    }
    els.btnListModels.disabled = true;
    els.btnListModels.textContent = "…";
    vscode.postMessage({ type: "listModels", id });
  });

  els.agentForm.addEventListener("submit", (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: "saveAgent",
      autonomy: els.autonomy.value,
      maxToolRounds: Number(els.maxToolRounds.value || 25),
      temperature: Number(els.temperature.value || 0.2),
      autoApproveReads: els.autoApproveReads.checked,
      requireApprovalForWrites: els.requireApprovalForWrites.checked,
      requireApprovalForTerminal: els.requireApprovalForTerminal.checked,
      systemPromptExtra: els.systemPromptExtra.value,
    });
  });

  els.btnOpenRules.addEventListener("click", () => {
    vscode.postMessage({ type: "openRules" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === "state") {
      state = msg;
      fillProviders();
      const active =
        (state.profiles || []).find((p) => p.id === state.activeProfileId) ||
        (state.profiles || [])[0];
      if (mode !== "create") {
        selectedId = active?.id || null;
        fillProfileForm(active);
      }
      renderProfileList();
      fillAgentForm(state.agent || {});
      return;
    }

    if (msg.type === "providerDefaults") {
      if (mode === "create" || !els.model.value) {
        els.model.value = msg.model || els.model.value;
      }
      if (mode === "create" || !els.baseUrl.value) {
        els.baseUrl.value = msg.baseUrl || "";
      }
      return;
    }

    if (msg.type === "models") {
      els.btnListModels.disabled = false;
      els.btnListModels.textContent = "Listar";
      const models = msg.models || [];
      els.modelPicker.innerHTML = "";
      if (!models.length) {
        els.modelPicker.classList.add("hidden");
        showToast("Nenhum modelo retornado.", "error");
        return;
      }
      els.modelPicker.classList.remove("hidden");
      models.forEach((m) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = m.label || m.id;
        b.title = m.detail || m.id;
        b.addEventListener("click", () => {
          els.model.value = m.id;
          els.modelPicker.classList.add("hidden");
        });
        els.modelPicker.appendChild(b);
      });
      return;
    }

    if (msg.type === "toast") {
      if (msg.level !== "error") mode = "edit";
      showToast(msg.text, msg.level);
      els.btnListModels.disabled = false;
      els.btnListModels.textContent = "Listar";
    }
  });

  vscode.postMessage({ type: "ready" });
})();
