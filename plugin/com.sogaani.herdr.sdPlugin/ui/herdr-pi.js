/* global SDPIComponents */
// Property inspector logic shared by the agent, slot and dial actions.
// All settings are read and written explicitly through streamDeckClient so the
// host list (an array) and the action settings never overwrite each other.
(() => {
  const client = SDPIComponents.streamDeckClient;
  const kind = document.body.dataset.kind; // "agent" | "slot" | "dial"
  const allowAllHosts = kind !== "agent";
  const $ = (id) => document.getElementById(id);

  let settings = {};
  let hosts = [];
  let statusByHost = new Map();
  let editing = null; // host config being edited, or null

  // ---------------------------------------------------------------- messaging
  const waiters = new Map(); // event -> resolve
  client.sendToPropertyInspector.subscribe((message) => {
    const payload = message.payload || {};
    const resolve = waiters.get(payload.event);
    if (resolve) {
      waiters.delete(payload.event);
      resolve(payload);
    }
  });

  function ask(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(payload.event);
        reject(new Error(`timed out waiting for ${payload.event}`));
      }, timeoutMs);
      waiters.set(payload.event, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      client.send("sendToPlugin", payload);
    });
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await client.setSettings(settings);
  }

  function setStatus(el, text, cls) {
    el.textContent = text || "";
    el.className = `status${cls ? ` ${cls}` : ""}`;
  }

  // ----------------------------------------------------------- action settings
  function fillHostSelect() {
    const select = $("hostId");
    const current = settings.hostId ?? (allowAllHosts ? "" : undefined);
    select.innerHTML = "";
    if (allowAllHosts) select.append(new Option("All hosts", ""));
    else select.append(new Option(hosts.length ? "Select a host…" : "No hosts configured yet", "__none__"));
    for (const h of hosts) select.append(new Option(h.label, h.id));
    const value = current === undefined ? "__none__" : current;
    select.value = [...select.options].some((o) => o.value === value) ? value : select.options[0]?.value ?? "";
  }

  async function fillAgentSelect() {
    const select = $("paneId");
    if (!select) return;
    const hostId = settings.hostId;
    select.innerHTML = "";
    if (!hostId) {
      select.append(new Option("Select a host first", ""));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    try {
      const reply = await ask({ event: "getAgents", hostId });
      const items = reply.items || [];
      select.append(new Option(items.length ? "Select an agent…" : "No agents found (is Herdr running?)", ""));
      for (const item of items) select.append(new Option(item.label, item.value));
      if (settings.paneId) {
        if (![...select.options].some((o) => o.value === settings.paneId)) {
          select.append(new Option(`${settings.agentLabel || settings.paneId} (not running)`, settings.paneId));
        }
        select.value = settings.paneId;
      }
    } catch (err) {
      select.append(new Option(`Could not load agents: ${err.message}`, ""));
    }
  }

  function renderActionSettings() {
    fillHostSelect();
    if ($("slot")) $("slot").value = settings.slot ?? 1;
    $("shortPress").value = settings.shortPress ?? "approve";
    $("longPress").value = settings.longPress ?? "decline";
    $("approveKeys").value = settings.approveKeys ?? "";
    $("denyKeys").value = settings.denyKeys ?? "";
    $("requireBlocked").checked = settings.requireBlocked !== false;
    void fillAgentSelect();
  }

  $("hostId").addEventListener("change", async (ev) => {
    const value = ev.target.value;
    if (value === "__none__") return;
    await saveSettings({ hostId: value, ...(kind === "agent" ? { paneId: undefined, sessionId: undefined, agentLabel: undefined } : {}) });
    void fillAgentSelect();
  });
  $("paneId")?.addEventListener("change", async (ev) => {
    const option = ev.target.selectedOptions[0];
    await saveSettings({ paneId: ev.target.value || undefined, agentLabel: option?.textContent?.replace(/ \[.*$/, "") });
  });
  $("refreshAgents")?.addEventListener("click", () => void fillAgentSelect());
  $("slot")?.addEventListener("change", (ev) => void saveSettings({ slot: Math.max(1, Number(ev.target.value) || 1) }));
  $("shortPress").addEventListener("change", (ev) => void saveSettings({ shortPress: ev.target.value }));
  $("longPress").addEventListener("change", (ev) => void saveSettings({ longPress: ev.target.value }));
  $("approveKeys").addEventListener("change", (ev) => void saveSettings({ approveKeys: ev.target.value.trim() || undefined }));
  $("denyKeys").addEventListener("change", (ev) => void saveSettings({ denyKeys: ev.target.value.trim() || undefined }));
  $("requireBlocked").addEventListener("change", (ev) => void saveSettings({ requireBlocked: ev.target.checked }));

  // -------------------------------------------------------------- host list
  function describeHost(h) {
    if (h.mode === "local") return `Local${h.session ? ` · session ${h.session}` : ""}`;
    const auth = h.auth || {};
    const who = auth.username ? `${auth.username}@` : "";
    const authKind = auth.type === "password" ? "password" : auth.type === "key" ? "key" : "ssh-agent";
    return `SSH · ${who}${h.host}${h.port ? `:${h.port}` : ""} · ${authKind}${h.remoteSession ? ` · session ${h.remoteSession}` : ""}`;
  }

  function renderHostList() {
    const list = $("hostList");
    list.innerHTML = "";
    if (hosts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No hosts yet. Add the machine running Herdr below.";
      list.append(empty);
    }
    for (const h of hosts) {
      const item = document.createElement("div");
      item.className = "host-item";
      const status = statusByHost.get(h.id);
      const dot = document.createElement("span");
      dot.className = `dot ${status?.state ?? ""}`;
      dot.title = status ? `${status.state}${status.error ? `: ${status.error}` : ""}` : "not in use";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = h.label;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = describeHost(h) + (status?.state === "online" ? ` · ${status.agents} agent(s)` : status?.error ? ` · ${status.error}` : "");
      name.append(meta);
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openEditor(structuredClone(h)));
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.className = "danger";
      remove.addEventListener("click", () => void saveHosts(hosts.filter((x) => x.id !== h.id)));
      item.append(dot, name, edit, remove);
      list.append(item);
    }
  }

  async function saveHosts(next) {
    const reply = await ask({ event: "saveHosts", hosts: next });
    if (!reply.ok) {
      setStatus($("hostStatus"), reply.error || "could not save hosts", "error");
      return false;
    }
    hosts = reply.hosts || next;
    setStatus($("hostStatus"), "Saved.", "ok");
    renderHostList();
    fillHostSelect();
    void fillAgentSelect();
    return true;
  }

  async function refreshStatus() {
    try {
      const reply = await ask({ event: "getStatus" }, 5000);
      statusByHost = new Map((reply.hosts || []).map((h) => [h.hostId, h]));
      renderHostList();
    } catch {
      /* plugin busy; try again on the next tick */
    }
  }

  // ------------------------------------------------------------- host editor
  const editor = $("editor");
  const field = (name) => editor.querySelector(`[name="${name}"]`);

  function openEditor(host) {
    editing = host || {
      id: `host-${Date.now().toString(36)}`,
      label: "",
      mode: "ssh",
      host: "",
      auth: { type: "password", username: "" },
    };
    field("label").value = editing.label || "";
    field("mode").value = editing.mode || "ssh";
    field("session").value = editing.session || "";
    field("socketPath").value = editing.socketPath || "";
    field("herdrBinary").value = editing.herdrBinary || "";
    field("host").value = editing.host || "";
    field("port").value = editing.port || "";
    field("username").value = editing.auth?.username || "";
    field("authType").value = editing.auth?.type || "password";
    field("password").value = editing.auth?.password || "";
    field("identityFile").value = editing.auth?.identityFile || "";
    field("passphrase").value = editing.auth?.passphrase || "";
    field("remoteSession").value = editing.remoteSession || "";
    field("remoteSocketPath").value = editing.remoteSocketPath || "";
    $("hostKeyInfo").textContent = editing.knownHostKey ? `Known host key: ${editing.knownHostKey}` : "Host key: learned on first connection";
    $("resetHostKey").classList.toggle("hidden", !editing.knownHostKey);
    setStatus($("editorStatus"), "");
    updateEditorVisibility();
    editor.classList.remove("hidden");
    field("label").focus();
  }

  function updateEditorVisibility() {
    const mode = field("mode").value;
    const authType = field("authType").value;
    editor.querySelectorAll("[data-mode]").forEach((el) => el.classList.toggle("hidden", el.dataset.mode !== mode));
    editor.querySelectorAll("[data-auth]").forEach((el) => el.classList.toggle("hidden", mode !== "ssh" || el.dataset.auth !== authType));
  }

  function readEditor() {
    const mode = field("mode").value;
    const base = { id: editing.id, label: field("label").value.trim(), mode };
    if (mode === "local") {
      return {
        ...base,
        session: field("session").value.trim() || undefined,
        socketPath: field("socketPath").value.trim() || undefined,
        herdrBinary: field("herdrBinary").value.trim() || undefined,
      };
    }
    const authType = field("authType").value;
    const username = field("username").value.trim();
    const auth =
      authType === "password"
        ? { type: "password", username, password: field("password").value }
        : authType === "key"
          ? { type: "key", username, identityFile: field("identityFile").value.trim(), passphrase: field("passphrase").value || undefined }
          : { type: "agent", username };
    return {
      ...base,
      host: field("host").value.trim(),
      port: Number(field("port").value) || undefined,
      auth,
      remoteSession: field("remoteSession").value.trim() || undefined,
      remoteSocketPath: field("remoteSocketPath").value.trim() || undefined,
      knownHostKey: editing.knownHostKey || undefined,
    };
  }

  field("mode").addEventListener("change", updateEditorVisibility);
  field("authType").addEventListener("change", updateEditorVisibility);

  $("addHost").addEventListener("click", () => openEditor(null));
  $("cancelEdit").addEventListener("click", () => {
    editing = null;
    editor.classList.add("hidden");
  });
  $("saveHost").addEventListener("click", async () => {
    const host = readEditor();
    const index = hosts.findIndex((h) => h.id === host.id);
    const next = index >= 0 ? hosts.map((h) => (h.id === host.id ? host : h)) : [...hosts, host];
    if (await saveHosts(next)) {
      editing = null;
      editor.classList.add("hidden");
      if (!settings.hostId && !allowAllHosts) {
        await saveSettings({ hostId: host.id });
        fillHostSelect();
        void fillAgentSelect();
      }
    }
  });
  $("testHost").addEventListener("click", async () => {
    const button = $("testHost");
    button.disabled = true;
    setStatus($("editorStatus"), "Testing connection…", "warn");
    try {
      const reply = await ask({ event: "testHost", host: readEditor() }, 40000);
      const extra = reply.fingerprint ? `\nhost key ${reply.fingerprint}` : reply.socketPath ? `\nsocket ${reply.socketPath}` : "";
      setStatus($("editorStatus"), `${reply.message}${extra}`, reply.ok ? "ok" : "error");
    } catch (err) {
      setStatus($("editorStatus"), err.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  $("resetHostKey").addEventListener("click", () => {
    if (!editing) return;
    editing.knownHostKey = undefined;
    $("hostKeyInfo").textContent = "Host key will be learned again on the next connection.";
    $("resetHostKey").classList.add("hidden");
  });
  $("importMachines").addEventListener("click", async () => {
    setStatus($("hostStatus"), "Reading saved Herdr machines…", "warn");
    try {
      const reply = await ask({ event: "importMachines" }, 15000);
      if (!reply.ok) throw new Error(reply.error || "import failed");
      const incoming = (reply.hosts || []).filter((h) => !hosts.some((x) => x.id === h.id));
      if (incoming.length === 0) {
        setStatus($("hostStatus"), "No new saved machines found in Herdr.", "warn");
        return;
      }
      setStatus($("hostStatus"), `Imported ${incoming.length} machine(s); set the SSH user name and authentication for each.`, "ok");
      await saveHosts([...hosts, ...incoming]);
    } catch (err) {
      setStatus($("hostStatus"), err.message, "error");
    }
  });

  // ------------------------------------------------------------------ start
  (async () => {
    const info = await client.getConnectionInfo();
    settings = info.actionInfo?.payload?.settings || {};
    const globalSettings = (await client.getGlobalSettings()) || {};
    hosts = Array.isArray(globalSettings.hosts) ? globalSettings.hosts : [];
    renderActionSettings();
    renderHostList();
    void refreshStatus();
    setInterval(() => void refreshStatus(), 4000);
  })();

  client.didReceiveGlobalSettings.subscribe((message) => {
    const next = message.payload?.settings?.hosts;
    if (Array.isArray(next)) {
      hosts = next;
      renderHostList();
      fillHostSelect();
    }
  });
})();
