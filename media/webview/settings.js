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
    modelStatus: $("modelStatus"),
    contextWindow: $("contextWindow"),
    contextHint: $("contextHint"),
    baseUrl: $("baseUrl"),
    tlsInsecure: $("tlsInsecure"),
    apiKey: $("apiKey"),
    keyStatus: $("keyStatus"),
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
  let fetchTimer = null;
  let lastFetchKey = "";
  let availableModels = [];

  function showToast(text, level) {
    els.toast.textContent = text || "";
    els.toast.classList.remove("hidden", "ok", "error");
    els.toast.classList.add(level === "error" ? "error" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3500);
  }

  function setModelStatus(text) {
    els.modelStatus.textContent = text ? "· " + text : "";
  }

  function setContextHint(text) {
    if (!els.contextHint) return;
    els.contextHint.textContent = text ? "· " + text : "";
  }

  function applyContextFromModel(modelId, source) {
    if (!els.contextWindow) return;
    const info = availableModels.find((m) => m.id === modelId);
    if (info && info.contextWindow) {
      els.contextWindow.value = String(info.contextWindow);
      setContextHint(
        info.contextFromApi ? "da API" : source === "default" ? "padrão" : "sugerido"
      );
      return;
    }
    if (!els.contextWindow.value) {
      els.contextWindow.value = "128000";
      setContextHint("padrão");
    }
  }

  function fillProviders() {
    const current = els.provider.value;
    els.provider.innerHTML = "";
    (state.providers || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      els.provider.appendChild(opt);
    });
    if (current) els.provider.value = current;
  }

  function resetModelSelect(placeholder) {
    availableModels = [];
    els.model.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder || "Aguardando listagem do provedor…";
    els.model.appendChild(opt);
  }

  function populateModelSelect(models, selected) {
    availableModels = models || [];
    const previous = selected || els.model.value || "";
    els.model.innerHTML = "";
    if (!availableModels.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhum modelo retornado";
      els.model.appendChild(opt);
      setModelStatus("vazio");
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Selecione um modelo…";
    els.model.appendChild(placeholder);
    availableModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (m.detail) opt.title = m.detail;
      els.model.appendChild(opt);
    });
    if (previous && availableModels.some((m) => m.id === previous)) {
      els.model.value = previous;
    } else {
      els.model.value = "";
    }
    setModelStatus(availableModels.length + " modelo(s)");
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
        (p.model || "sem modelo") +
        (p.requiresKey && !p.hasKey ? " · sem key" : "");
      btn.appendChild(title);
      btn.appendChild(meta);
      btn.addEventListener("click", () => {
        mode = "edit";
        selectedId = p.id;
        fillProfileForm(p);
        renderProfileList();
        requestModels({ autoSelect: false, force: true });
      });
      els.profileList.appendChild(btn);
    });
  }

  function fillProfileForm(p) {
    els.profileTitle.textContent = mode === "create" ? "Novo perfil" : "Perfil";
    els.profileId.value = p?.id || "";
    els.name.value = p?.name || "";
    els.provider.value = p?.provider || "openai";
    els.baseUrl.value = p?.baseUrl || "";
    els.tlsInsecure.checked = Boolean(p?.tlsInsecure);
    els.apiKey.value = "";
    if (!p) els.keyStatus.textContent = "";
    else if (!p.requiresKey) els.keyStatus.textContent = "(opcional)";
    else els.keyStatus.textContent = p.hasKey ? "· configurada" : "· ausente";

    resetModelSelect(
      p?.hasKey || !p?.requiresKey
        ? "Carregando modelos do provedor…"
        : "Informe a API key para listar modelos"
    );
    if (p?.model) {
      const opt = document.createElement("option");
      opt.value = p.model;
      opt.textContent = p.model + " (atual)";
      els.model.appendChild(opt);
      els.model.value = p.model;
    }
    if (els.contextWindow) {
      els.contextWindow.value =
        p?.contextWindow && p.contextWindow >= 1024
          ? String(p.contextWindow)
          : "128000";
      setContextHint(p?.contextWindow ? "salvo" : "padrão");
    }
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
      contextWindow: Number(els.contextWindow?.value || 128000),
    };
  }

  function canFetchModels() {
    const provider = els.provider.value;
    const profile = (state.profiles || []).find((p) => p.id === els.profileId.value);
    const typedKey = (els.apiKey.value || "").trim();
    const hasSavedKey = Boolean(profile?.hasKey);
    const requiresKey = profile ? profile.requiresKey : provider !== "ollama";
    if (requiresKey && !typedKey && !hasSavedKey) return false;
    if (provider === "openai-compatible" && !(els.baseUrl.value || "").trim()) return false;
    return true;
  }

  function requestModels(opts) {
    opts = opts || {};
    if (!canFetchModels()) {
      resetModelSelect("Informe a API key (e Base URL, se preciso) para listar");
      setModelStatus("aguardando credenciais");
      return;
    }
    const payload = {
      type: "fetchModels",
      profileId: els.profileId.value || undefined,
      provider: els.provider.value,
      baseUrl: els.baseUrl.value,
      tlsInsecure: els.tlsInsecure.checked,
      apiKey: (els.apiKey.value || "").trim() || undefined,
      autoSelect: Boolean(opts.autoSelect),
      selected: els.model.value || undefined,
    };
    const key = [
      payload.profileId || "",
      payload.provider,
      payload.baseUrl || "",
      String(payload.tlsInsecure),
      payload.apiKey ? "typed-key" : "saved-key",
    ].join("|");
    if (!opts.force && key === lastFetchKey && availableModels.length) return;
    lastFetchKey = key;
    setModelStatus("listando…");
    els.btnListModels.disabled = true;
    els.btnListModels.textContent = "…";
    vscode.postMessage(payload);
  }

  function scheduleFetchModels(autoSelect) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(
      () => requestModels({ autoSelect: Boolean(autoSelect), force: true }),
      350
    );
  }

  function startCreate() {
    mode = "create";
    selectedId = null;
    lastFetchKey = "";
    fillProfileForm({
      id: "",
      name: "Novo perfil",
      provider: "openai",
      model: "",
      baseUrl: "",
      tlsInsecure: false,
      contextWindow: 128000,
      hasKey: false,
      requiresKey: true,
    });
    renderProfileList();
    vscode.postMessage({ type: "defaultsForProvider", provider: "openai" });
  }

  els.btnNewProfile.addEventListener("click", startCreate);

  els.provider.addEventListener("change", () => {
    lastFetchKey = "";
    resetModelSelect("Atualize a key/URL e aguarde a lista…");
    vscode.postMessage({ type: "defaultsForProvider", provider: els.provider.value });
    scheduleFetchModels(true);
  });

  els.baseUrl.addEventListener("change", () => scheduleFetchModels(true));
  els.baseUrl.addEventListener("blur", () => scheduleFetchModels(false));
  els.tlsInsecure.addEventListener("change", () => scheduleFetchModels(false));
  els.apiKey.addEventListener("change", () => scheduleFetchModels(true));
  els.apiKey.addEventListener("blur", () => scheduleFetchModels(true));
  els.apiKey.addEventListener("input", () => {
    if ((els.apiKey.value || "").trim().length > 12) scheduleFetchModels(true);
  });

  els.model.addEventListener("change", () => {
    applyContextFromModel(els.model.value);
    if (mode === "edit" && els.profileId.value && els.model.value) {
      vscode.postMessage({
        type: "setModel",
        id: els.profileId.value,
        model: els.model.value,
        contextWindow: Number(els.contextWindow?.value || 128000),
      });
    }
  });

  if (els.contextWindow) {
    els.contextWindow.addEventListener("change", () => {
      setContextHint("editado");
      if (mode === "edit" && els.profileId.value && els.model.value) {
        vscode.postMessage({
          type: "setModel",
          id: els.profileId.value,
          model: els.model.value,
          contextWindow: Number(els.contextWindow.value || 128000),
        });
      }
    });
  }

  els.profileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = profilePayload();
    if (!payload.model) {
      showToast("Selecione um modelo da lista do provedor.", "error");
      requestModels({ autoSelect: false, force: true });
      return;
    }
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
    requestModels({ autoSelect: false, force: true });
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
        if (active && (active.hasKey || !active.requiresKey)) {
          requestModels({ autoSelect: false, force: true });
        }
      }
      renderProfileList();
      fillAgentForm(state.agent || {});
      return;
    }

    if (msg.type === "providerDefaults") {
      if (mode === "create" || !els.baseUrl.value) {
        els.baseUrl.value = msg.baseUrl || "";
      }
      if (msg.requiresKey === false) {
        els.keyStatus.textContent = "(opcional)";
        scheduleFetchModels(true);
      }
      return;
    }

    if (msg.type === "modelsStatus") {
      if (msg.status === "loading") setModelStatus("listando…");
      return;
    }

    if (msg.type === "models") {
      els.btnListModels.disabled = false;
      els.btnListModels.textContent = "Atualizar";
      if (msg.status === "missing-key") {
        resetModelSelect("Informe a API key para listar modelos");
        setModelStatus("sem key");
        return;
      }
      const models = msg.models || [];
      populateModelSelect(models, msg.selected);
      if (msg.autoSelect && msg.selected) {
        els.model.value = msg.selected;
        applyContextFromModel(els.model.value);
      } else if (els.model.value && (!els.contextWindow?.value || Number(els.contextWindow.value) < 1024)) {
        applyContextFromModel(els.model.value);
      }
      return;
    }

    if (msg.type === "toast") {
      if (msg.level !== "error") mode = "edit";
      showToast(msg.text, msg.level);
      els.btnListModels.disabled = false;
      els.btnListModels.textContent = "Atualizar";
    }
  });

  vscode.postMessage({ type: "ready" });
})();
