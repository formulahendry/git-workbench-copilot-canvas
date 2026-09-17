"use strict";

import { defaultPreferences, preferenceLimits, validatePreferences } from "./preferences.mjs";

(() => {
  const $ = (id) => document.getElementById(id);
  const defaults = () => ({ ...defaultPreferences(), historyRef: "HEAD" });
  const state = {
    bootstrap: null, repositories: [], repo: "", epoch: 0, selectionSeq: 0, snapshot: null,
    settings: defaults(), pending: 0, lastRefresh: null, writePending: false,
    executing: false, modal: null, returnFocus: null, error: null,
    snapshotSeq: 0, detailSeq: 0, filesSeq: 0, historySeq: 0,
    detail: { kind: "overview" }, detailData: null, detailLoading: false,
    history: null, files: null, selections: { staged: new Set(), working: new Set(), conflicts: new Set() },
    drafts: new Map(), fileTimer: null, reads: new Map(), preferenceWrites: Promise.resolve(),
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function button(label, title, action, className = "") {
    const element = node("button", className, label);
    element.type = "button";
    element.title = title;
    element.setAttribute("aria-label", title);
    element.addEventListener("click", () => run(action, title));
    return element;
  }

  function option(value, label) {
    const element = node("option", "", label);
    element.value = value;
    return element;
  }

  function shortPath(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  }

  function formatDate(value) {
    if (!value) return "Unknown date";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-US", { hour12: false });
  }

  function errorText(error) {
    return `${error.code ? `[${error.code}] ` : ""}${error.message || String(error)}`;
  }

  // Only interaction boundaries catch failures. Obsolete reads cannot overwrite a newer view.
  async function run(action, label, retry = action, retryLabel = "Retry") {
    const epoch = state.epoch;
    let generation = state.detailSeq;
    try {
      const result = action();
      generation = state.detailSeq;
      await result;
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      if (epoch !== state.epoch && error.repo && error.repo !== state.repo) return false;
      if (error.readEpoch !== undefined && error.readEpoch !== state.epoch) return false;
      if (error.readChannel === "detail" && error.readSequence !== state.detailSeq) return false;
      showError(error, label, retry, retryLabel);
      if (state.modal) {
        $("modal-error").hidden = false;
        $("modal-error").textContent = errorText(error);
      }
      if (state.detailLoading && generation === state.detailSeq) {
        state.detailLoading = false;
        const empty = node("div", "empty-state");
        empty.append(node("h2", "", "Unable to load content"), node("p", "muted", "The error is shown above. Retry or select another view."));
        empty.append(button("Reload", "Reload the current view", () => state.snapshot ? reloadDetail() : refreshAll(), "primary"));
        $("detail").replaceChildren(empty);
      }
      return false;
    }
  }

  async function api(payload, signal) {
    const requestEpoch = state.epoch;
    const requestSequence = state.detailSeq;
    state.pending += 1;
    renderStatus();
    try {
      const response = await fetch("/api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Git-Workbench-Token": state.bootstrap.token },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        const error = new Error(result.error?.message || `HTTP ${response.status}`);
        error.code = result.error?.code || `http_${response.status}`;
        error.repo = payload.repo;
        if (payload.action === "read") {
          error.readEpoch = requestEpoch;
          error.readSequence = requestSequence;
          error.readChannel = ["snapshot", "files", "history"].includes(payload.view) ? payload.view : "detail";
        }
        throw error;
      }
      return result;
    } finally {
      state.pending -= 1;
      renderStatus();
    }
  }

  async function read(view, args = {}, repo = state.repo) {
    const channel = ["snapshot", "files", "history"].includes(view) ? view : "detail";
    state.reads.get(channel)?.abort();
    const controller = new AbortController();
    state.reads.set(channel, controller);
    try {
      return await api({ action: "read", repo, view, args }, controller.signal);
    } finally {
      if (state.reads.get(channel) === controller) state.reads.delete(channel);
    }
  }

  function abortReads(channel) {
    if (channel) state.reads.get(channel)?.abort();
    else for (const controller of state.reads.values()) controller.abort();
  }

  function showError(error, title, retry, retryLabel = "Retry") {
    state.error = { error, title, retry, retryLabel, repo: error.repo || state.repo };
    $("error-title").textContent = title;
    $("error-message").textContent = errorText(error);
    $("error-banner").hidden = false;
    $("error-retry").textContent = retryLabel;
    $("error-retry").hidden = !retry || Boolean(state.error.repo && state.error.repo !== state.repo);
  }

  function clearError() {
    state.error = null;
    $("error-banner").hidden = true;
  }

  function showNotice(message, output) {
    const notice = $("notice");
    notice.replaceChildren(button("Dismiss", "Dismiss operation result", () => { notice.hidden = true; }, "text-button"), node("span", "", message));
    if (output) {
      const details = node("details");
      details.append(node("summary", "", "View Git output"), node("pre", "", output));
      notice.append(details);
    }
    notice.hidden = false;
  }

  async function loadSettings(repo) {
    await state.preferenceWrites;
    const saved = await api({ action: "get_preferences", repo });
    return { ...defaults(), ...validatePreferences(saved) };
  }

  function saveSettings(preferences) {
    if (!state.repo) return;
    const repo = state.repo;
    const patch = validatePreferences(preferences);
    // Capture the target and patch now; a later repository switch must not redirect a queued save.
    const write = state.preferenceWrites.then(() => api({ action: "set_preferences", repo, preferences: patch }));
    state.preferenceWrites = write.catch((error) => {
      showError(error, "UI preferences were not saved", null);
    });
  }

  function section(label, count, key, initiallyOpen = true, className = "tree-section") {
    const details = node("details", className);
    const initial = Object.hasOwn(state.settings.expanded, key) ? state.settings.expanded[key] : initiallyOpen;
    details.open = initial;
    const summary = node("summary", "", label);
    if (count !== null) summary.append(node("span", "count", count));
    details.append(summary);
    let previous = initial;
    details.addEventListener("toggle", () => run(() => {
      if (!details.isConnected || details.open === previous) return;
      previous = details.open;
      delete state.settings.expanded[key];
      state.settings.expanded[key] = details.open;
      const recent = Object.entries(state.settings.expanded).slice(-preferenceLimits.expanded);
      state.settings.expanded = Object.fromEntries(recent);
      saveSettings({ expanded: state.settings.expanded });
    }, "Save tree preference"));
    return details;
  }

  function setSidebar(open) {
    $("app").classList.toggle("sidebar-open", open);
    $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  }

  function renderStatus() {
    $("status-text").textContent = state.executing ? "Running confirmed Git operation..." :
      state.writePending ? "Awaiting confirmation · Auto-refresh paused" :
      state.pending ? `Loading · Requests: ${state.pending}` :
      state.lastRefresh ? `Updated at ${state.lastRefresh.toLocaleTimeString("en-US", { hour12: false })}` : "Ready";
    $("status-repo").textContent = state.repo;
    $("status-repo").title = state.repo;
  }

  function changeGroups() {
    const changes = state.snapshot?.changes || [];
    const changed = (status) => Boolean(status && ![".", " ", "?"].includes(status));
    return {
      staged: changes.filter((change) => !change.conflict && changed(change.index)),
      working: changes.filter((change) => !change.conflict && (change.untracked || changed(change.worktree))),
      conflicts: changes.filter((change) => change.conflict),
    };
  }

  function syncControls() {
    const snapshot = state.snapshot;
    const blocked = state.writePending;
    const ready = Boolean(snapshot && !blocked);
    $("app").inert = blocked || Boolean(state.modal);
    $("repo-select").disabled = blocked || !state.repositories.length && !state.repo;
    $("remove-repo").disabled = blocked || !state.repositories.some((entry) => entry.path === state.repo);
    $("refresh").disabled = blocked || !state.bootstrap;
    $("remote-select").disabled = !ready || !snapshot.remotes.length;
    $("fetch").disabled = !ready || !snapshot.remotes.length;
    $("pull").disabled = !ready || !snapshot.upstream;
    $("push").disabled = !ready || !snapshot.upstream;
    $("branch-create").disabled = !ready;
    $("stash-create").disabled = !ready;
    $("compare-open").disabled = !ready;
    $("commit-message").disabled = !ready;
    $("commit-button").disabled = !ready || !changeGroups().staged.length || !$("commit-message").value.trim();
    $("auto-refresh").checked = state.settings.autoRefresh;
    renderStatus();
  }

  function renderCatalog() {
    const select = $("repo-select");
    select.replaceChildren();
    const entries = [...state.repositories];
    if (state.repo && !entries.some((entry) => entry.path === state.repo)) entries.push({ path: state.repo, name: shortPath(state.repo) });
    if (!entries.length || !state.repo) select.append(option("", entries.length ? "Select a repository" : "Add a local repository"));
    for (const entry of entries) select.append(option(entry.path, entry.name || shortPath(entry.path)));
    select.value = state.repo;
    $("repo-path").textContent = state.repo || "Repository list saved by the local service";
    $("repo-path").title = state.repo;
    syncControls();
  }

  async function refreshCatalog() {
    const catalog = await api({ action: "catalog" });
    state.repositories = catalog.repositories;
    renderCatalog();
  }

  async function selectRepository(repo, { remember = false } = {}) {
    if (state.writePending) return;
    const selection = ++state.selectionSeq;
    if (remember && repo) {
      const catalog = await api({ action: "select_repository", repo });
      if (selection !== state.selectionSeq) return;
      state.repositories = catalog.repositories;
    }
    const settings = repo ? await loadSettings(repo) : defaults();
    if (selection !== state.selectionSeq) return;
    abortReads();
    if (state.repo) state.drafts.set(state.repo, $("commit-message").value);
    state.epoch += 1;
    state.snapshotSeq += 1;
    state.detailSeq += 1;
    state.filesSeq += 1;
    state.historySeq += 1;
    clearTimeout(state.fileTimer);
    state.repo = repo;
    state.snapshot = null;
    state.files = null;
    state.history = null;
    state.lastRefresh = null;
    state.detailData = null;
    state.detailLoading = false;
    state.detail = { kind: "overview" };
    state.selections = { staged: new Set(), working: new Set(), conflicts: new Set() };
    state.settings = settings;
    $("commit-message").value = state.drafts.get(repo) || "";
    $("change-filter").value = state.settings.changeFilter;
    $("file-search").value = state.settings.fileSearch;
    $("change-trees").replaceChildren();
    $("reference-trees").replaceChildren();
    $("files-tree").replaceChildren();
    $("files-note").textContent = "";
    $("changes-count").textContent = "0";
    $("head-badge").textContent = repo ? "Loading..." : "No repository selected";
    $("sync-summary").textContent = repo ? "Loading repository..." : "Select a repository to begin";
    $("remote-select").replaceChildren();
    $("notice").hidden = true;
    if (state.error) $("error-retry").hidden = !state.error.retry || Boolean(state.error.repo && state.error.repo !== repo);
    renderCatalog();
    renderTabs();
    if (!repo) {
      renderWelcome();
      return;
    }
    $("detail").replaceChildren(node("div", "loading", "Loading repository status..."));
    state.detailLoading = true;
    const epoch = state.epoch;
    await refreshSnapshot();
    if (epoch !== state.epoch || !state.snapshot) return;
    state.detailLoading = false;
    if (state.settings.tab === "history") await showHistory({ ref: "HEAD", search: "", path: "" });
    else {
      renderOverview();
      if (state.settings.tab === "files") await loadFiles();
    }
  }

  async function refreshSnapshot() {
    if (!state.repo || state.writePending) return;
    const epoch = state.epoch;
    const sequence = ++state.snapshotSeq;
    const snapshot = await read("snapshot");
    if (epoch !== state.epoch || sequence !== state.snapshotSeq) return;
    state.snapshot = snapshot;
    if (state.history) state.history.stale = true;
    state.lastRefresh = new Date();
    renderSnapshot();
  }

  async function refreshAll() {
    if (state.writePending) return;
    const epoch = state.epoch;
    const detailSequence = state.detailSeq;
    await refreshCatalog();
    if (epoch !== state.epoch) return;
    if (!state.repo) {
      renderWelcome();
      return;
    }
    await refreshSnapshot();
    if (epoch !== state.epoch || state.writePending) return;
    if (state.settings.tab === "files") await loadFiles();
    if (epoch === state.epoch && detailSequence === state.detailSeq) await reloadDetail();
  }

  function renderSnapshot() {
    const snapshot = state.snapshot;
    $("head-badge").textContent = `⑂ ${snapshot.branch || (snapshot.head ? `detached · ${snapshot.head.slice(0, 8)}` : "unborn HEAD")}`;
    $("head-badge").title = `${snapshot.branch || "Detached HEAD"}\n${snapshot.head || "No commits yet"}`;
    $("changes-count").textContent = snapshot.changes.length;
    $("sync-summary").textContent = snapshot.upstream
      ? `${snapshot.upstream} · ↑ ${snapshot.ahead} ahead · ↓ ${snapshot.behind} behind`
      : "No upstream configured · Pull / Push unavailable";
    const remoteNames = snapshot.remotes.map((remote) => remote.name);
    if (!remoteNames.includes(state.settings.remote)) state.settings.remote = remoteNames.includes("origin") ? "origin" : remoteNames[0] || "";
    $("remote-select").replaceChildren(...snapshot.remotes.map((remote) => option(remote.name, remote.name)));
    $("remote-select").value = state.settings.remote;
    renderChanges();
    renderReferences();
    syncControls();
    if (state.detail.kind === "overview" && !state.detailLoading) renderOverview();
  }

  function renderTabs() {
    for (const tab of ["changes", "history", "files"]) {
      const active = state.settings.tab === tab;
      $(`tab-${tab}`).classList.toggle("active", active);
      $(`tab-${tab}`).setAttribute("aria-pressed", String(active));
      $(`${tab}-panel`).hidden = !active;
    }
  }

  async function setTab(tab) {
    state.settings.tab = tab;
    saveSettings({ tab });
    renderTabs();
    if (!state.repo || !state.snapshot) return;
    if (tab === "history") {
      if (state.history && !state.history.stale) {
        abortReads("detail");
        state.detailSeq += 1;
        state.detailLoading = false;
        state.detail = { kind: "history" };
        renderHistory();
      } else await showHistory(state.history?.query || { ref: state.settings.historyRef, path: "", search: "" });
    }
    if (tab === "files" && !state.files) await loadFiles();
  }

  function renderWelcome() {
    const wrapper = node("div", "welcome");
    wrapper.append(node("span", "eyebrow", "YOUR CODE. YOUR HISTORY."), node("h1", "", "See the story behind every change."));
    wrapper.append(node("p", "", state.repositories.length
      ? "This session has no repository, and no previous selection is saved. Select one in the sidebar. Future opens will remember your choice and show its current branch."
      : "Add a local Git repository to explore its working tree, commits, branches, and blame."));
    wrapper.append(button("＋ Add repository", "Add a local repository", openAddRepository, "primary"));
    wrapper.append(node("p", "hint", "Local reads, no telemetry. Every Git write operation requires a command preview and your explicit confirmation."));
    $("detail").replaceChildren(wrapper);
  }

  function renderOverview() {
    if (!state.snapshot) return renderWelcome();
    const snapshot = state.snapshot;
    const groups = changeGroups();
    const hero = node("section", "overview-hero");
    hero.append(node("span", "eyebrow", "REPOSITORY OVERVIEW"), node("h1", "", snapshot.name || shortPath(state.repo)));
    hero.append(node("p", "", `${snapshot.branch || "Detached HEAD"} · ${snapshot.head ? snapshot.head.slice(0, 12) : "Waiting for the first commit"}`));
    if (snapshot.inProgress.length) hero.append(node("div", "warning-box", `Git operation in progress: ${snapshot.inProgress.join(", ")}. Resolve conflicts first. This interface will not automatically abort, reset, or continue these operations.`));
    const metrics = node("div", "metric-grid");
    for (const [count, label] of [[groups.staged.length, "Staged"], [groups.working.length, "Working tree changes"], [groups.conflicts.length, "Conflicts"], [snapshot.branches.filter((branch) => branch.ref.startsWith("refs/heads/")).length, "Local branches"]]) {
      const metric = node("div", "metric");
      metric.append(node("strong", "", count), node("span", "", label));
      metrics.append(metric);
    }
    hero.append(metrics);
    const cards = node("div", "overview-cards");
    const history = node("section", "info-card");
    history.append(node("h2", "", "Explore the story behind each commit"), node("p", "", "Inspect actual parent relationships, full commit messages, and patches. Search across branches or trace a single file."));
    history.append(button("Open commit history →", "Open commit history at HEAD", () => showHistory({ ref: "HEAD", path: "", search: "" })));
    const safety = node("section", "info-card");
    safety.append(node("h2", "", "Preview first, then change your repository"), node("p", "", "Staging, commits, branch switches, and remote operations preview the repository path and exact commands. No discard, force push, or hard reset."));
    safety.append(node("p", "hint", snapshot.upstream ? `Upstream: ${snapshot.upstream} · ↑ ${snapshot.ahead} / ↓ ${snapshot.behind}` : "This branch has no upstream. Remote tracking is never configured implicitly."));
    cards.append(history, safety);
    $("detail").replaceChildren(hero, cards);
  }

  function fileTree(items, key) {
    const root = { directories: new Map(), files: [] };
    for (const item of items) {
      const parts = item.path.split("/");
      let current = root;
      for (const part of parts.slice(0, -1)) {
        if (!current.directories.has(part)) current.directories.set(part, { directories: new Map(), files: [] });
        current = current.directories.get(part);
      }
      current.files.push({ ...item, filename: parts.at(-1) });
    }
    function draw(tree, prefix) {
      const list = node("ul", "tree-list");
      for (const [name, subtree] of [...tree.directories].sort(([a], [b]) => a.localeCompare(b))) {
        const path = `${prefix}${name}/`;
        const entry = node("li");
        const folder = section(`▱ ${name}`, null, `${key}:${path}`, true, "directory");
        folder.append(draw(subtree, path));
        entry.append(folder);
        list.append(entry);
      }
      for (const item of tree.files.sort((a, b) => a.filename.localeCompare(b.filename))) {
        const entry = node("li");
        const row = node("div", "file-row");
        if (item.group) {
          const checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.checked = state.selections[item.group].has(item.path);
          checkbox.setAttribute("aria-label", `Select ${item.path}`);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) state.selections[item.group].add(item.path);
            else state.selections[item.group].delete(item.path);
            updateSelectionButtons();
          });
          row.append(checkbox);
        }
        const main = button("", item.title || `${item.path}${item.originalPath ? ` (original path: ${item.originalPath})` : ""}`, item.open, "file-main");
        let statusClass = "";
        if (["A", "?", "??"].includes(item.status)) statusClass = " added";
        if (item.status === "D") statusClass = " deleted";
        if (item.status === "U") statusClass = " conflict";
        main.append(node("span", `file-status${statusClass}`, item.status || "·"), node("span", "filename", item.filename));
        row.append(main);
        if (item.actions?.length) {
          const actions = node("div", "row-actions");
          for (const action of item.actions) {
            const control = button(action.label, action.title, action.run);
            control.disabled = Boolean(action.disabled);
            actions.append(control);
          }
          row.append(actions);
        }
        entry.append(row);
        list.append(entry);
      }
      return list;
    }
    return draw(root, "");
  }

  function pathsForChanges(changes) {
    const paths = new Set();
    for (const change of changes) {
      paths.add(change.path);
      if (change.originalPath && (change.index === "R" || change.worktree === "R")) paths.add(change.originalPath);
    }
    return [...paths];
  }

  function updateSelectionButtons() {
    for (const group of ["staged", "working", "conflicts"]) {
      const control = document.querySelector(`[data-selection-group="${group}"]`);
      if (!control) continue;
      const count = state.selections[group].size;
      control.disabled = !count;
      control.textContent = `${group === "staged" ? "Unstage" : "Stage"} selected (${count})`;
    }
  }

  function renderChanges() {
    const groups = changeGroups();
    const container = $("change-trees");
    container.replaceChildren();
    const filter = state.settings.changeFilter.toLocaleLowerCase();
    for (const [group, label] of [["conflicts", "Conflicts"], ["staged", "Staged"], ["working", "Working tree"]]) {
      const changes = groups[group];
      state.selections[group] = new Set([...state.selections[group]].filter((path) => changes.some((change) => change.path === path)));
      if (group === "conflicts" && !changes.length) continue;
      const details = section(label, changes.length, `scm:${group}`);
      if (changes.length) {
        const operation = group === "staged" ? "unstage" : "stage";
        const tools = node("div", "tree-group-tools");
        const selected = button("", `${group === "staged" ? "Unstage" : "Stage"} selected files, including selections hidden by the filter`, () => {
          const selectedChanges = changeGroups()[group].filter((change) => state.selections[group].has(change.path));
          if (!selectedChanges.length) throw new Error("Select files first.");
          return prepareOperation(operation, { paths: pathsForChanges(selectedChanges) });
        });
        selected.dataset.selectionGroup = group;
        tools.append(selected);
        if (group !== "conflicts") tools.append(button(group === "staged" ? "Unstage all" : "Stage all", "Apply to the entire repository, including files hidden by the filter", () => prepareOperation(operation, { paths: [] })));
        details.append(tools);
      }
      const visible = changes.filter((change) => `${change.path}\n${change.originalPath || ""}`.toLocaleLowerCase().includes(filter));
      if (!visible.length) details.append(node("p", "tree-empty", changes.length ? "No matching paths" : group === "staged" ? "No staged changes" : "Working tree clean"));
      else details.append(fileTree(visible.map((change) => {
        const side = group === "staged" ? "staged" : "working";
        const historyPath = change.originalPath || change.path;
        return {
          ...change, group, status: change.conflict ? "U" : change.untracked ? "?" : group === "staged" ? change.index : change.worktree,
          open: () => showDetail({ kind: "diff", path: change.path, side }),
          actions: [
            { label: group === "staged" ? "−" : "＋", title: `${group === "staged" ? "Unstage" : "Stage"} ${change.path}`, run: () => prepareOperation(group === "staged" ? "unstage" : "stage", { paths: pathsForChanges([change]) }) },
            { label: "H", title: `View file history for ${historyPath}`, disabled: change.untracked, run: () => showHistory({ ref: "HEAD", path: historyPath, search: "" }) },
            { label: "B", title: `View blame for ${historyPath} at HEAD (committed version)`, disabled: change.untracked, run: () => showDetail({ kind: "blame", path: historyPath, ref: "HEAD" }) },
          ],
        };
      }), `scm:${group}`));
      container.append(details);
    }
    updateSelectionButtons();
  }

  function refRow(label, title, open, actions = [], current = false) {
    const row = node("div", "ref-row");
    const main = button(`${current ? "● " : ""}${label}`, title, open, `ref-main${current ? " ref-current" : ""}`);
    row.append(main);
    const controls = node("div", "row-actions");
    for (const action of actions) {
      const control = button(action.label, action.title, action.run);
      control.disabled = Boolean(action.disabled);
      controls.append(control);
    }
    row.append(controls);
    return row;
  }

  function renderReferences() {
    if (!state.snapshot) return;
    const snapshot = state.snapshot;
    const container = $("reference-trees");
    container.replaceChildren();
    for (const [prefix, label, key] of [["refs/heads/", "Local branches", "local"], ["refs/remotes/", "Remote branches", "remote"]]) {
      const branches = snapshot.branches.filter((branch) => branch.ref.startsWith(prefix));
      const tree = section(label, branches.length, `refs:${key}`, key === "local");
      for (const branch of branches) {
        const name = branch.ref.slice(prefix.length);
        const actions = key === "local" ? [{ label: "Switch", title: `Switch checkout to local branch ${name}`, disabled: branch.current, run: () => prepareOperation("switch_branch", { branch: name }) }] : [];
        tree.append(refRow(`⑂ ${name}`, `Browse history for ${branch.ref} without switching branches${branch.track ? ` · ${branch.track}` : ""}`, () => showHistory({ ref: branch.ref, path: "", search: "" }), actions, branch.current));
      }
      if (!branches.length) tree.append(node("p", "tree-empty", "No branches"));
      container.append(tree);
    }
    const tags = section("Tags", snapshot.tags.length, "refs:tags", false);
    for (const tag of snapshot.tags) tags.append(refRow(`◇ ${tag.name}`, `${tag.subject || tag.name}\n${formatDate(tag.date)}`, () => showHistory({ ref: `refs/tags/${tag.name}`, path: "", search: "" })));
    if (!snapshot.tags.length) tags.append(node("p", "tree-empty", "No tags"));
    const remotes = section("Remotes", snapshot.remotes.length, "refs:remotes", false);
    for (const remote of snapshot.remotes) {
      remotes.append(refRow(`↗ ${remote.name}`, remote.fetchUrl || remote.name, () => showRemote(remote), [
        { label: "↓", title: `Fetch ${remote.name}`, run: () => prepareOperation("fetch", { remote: remote.name }) },
      ]));
    }
    if (!snapshot.remotes.length) remotes.append(node("p", "tree-empty", "No remotes configured"));
    const stashes = section("Stashes", snapshot.stashes.length, "refs:stashes", true);
    for (const stash of snapshot.stashes) {
      stashes.append(refRow(`${stash.ref} · ${stash.subject}`, `${stash.subject}\n${formatDate(stash.date)}`, () => showDetail({ kind: "stash", ref: stash.ref }), [
        { label: "Apply", title: `Apply ${stash.ref} and keep the stash`, run: () => prepareOperation("stash_apply", { ref: stash.ref }) },
        { label: "Pop", title: `Apply ${stash.ref} and remove it on success`, run: () => prepareOperation("stash_pop", { ref: stash.ref }) },
      ]));
    }
    if (!snapshot.stashes.length) stashes.append(node("p", "tree-empty", "No stashes"));
    const worktrees = section("Worktrees", snapshot.worktrees.length, "refs:worktrees", false);
    for (const worktree of snapshot.worktrees) {
      const row = refRow(`${worktree.bare ? "▣" : "▱"} ${shortPath(worktree.path)}`, `Register and open ${worktree.path} without changing the checkout`, () => {
        if (worktree.bare) throw new Error("This is a bare repository with no working tree to browse.");
        return addAndOpenRepository(worktree.path);
      });
      row.querySelector("button").disabled = Boolean(worktree.bare);
      worktrees.append(row);
      worktrees.append(node("p", "ref-note", `${worktree.branch?.replace(/^refs\/heads\//, "") || "detached"}${worktree.locked ? " · locked" : ""}${worktree.prunable ? " · prunable" : ""}\n${worktree.path}`));
    }
    if (!snapshot.worktrees.length) worktrees.append(node("p", "tree-empty", "No worktrees"));
    container.append(tags, remotes, stashes, worktrees);
  }

  async function loadFiles() {
    if (!state.repo || state.writePending) return;
    const epoch = state.epoch;
    const sequence = ++state.filesSeq;
    const search = state.settings.fileSearch;
    $("files-note").textContent = "Loading files...";
    let finished = false;
    try {
      const result = await read("files", { search, limit: 2000 });
      if (epoch !== state.epoch || sequence !== state.filesSeq) return;
      state.files = result;
      const files = result.files.map((path) => ({
        path, title: `${path} · View blame at HEAD`,
        open: () => showDetail({ kind: "blame", path, ref: "HEAD" }),
        actions: [{ label: "H", title: `View history for ${path}`, run: () => showHistory({ ref: "HEAD", path, search: "" }) }],
      }));
      $("files-tree").replaceChildren(files.length ? fileTree(files, "files") : node("p", "tree-empty", "No matching tracked files"));
      $("files-note").textContent = `${files.length} files${result.truncated ? " · Results limited to 2,000 files. Narrow your path search." : ""}`;
      finished = true;
    } finally {
      if (!finished && epoch === state.epoch && sequence === state.filesSeq) $("files-note").textContent = "Unable to finish loading files. Retry or change the search.";
    }
  }

  function viewHeader(eyebrow, title, subtitle, actions = []) {
    const header = node("header", "view-header");
    header.append(node("span", "eyebrow", eyebrow));
    const row = node("div", "view-title-row");
    row.append(node("h1", "", title));
    if (actions.length) {
      const toolbar = node("div", "toolbar");
      toolbar.append(...actions);
      row.append(toolbar);
    }
    header.append(row);
    if (subtitle) header.append(node("p", "view-subtitle", subtitle));
    return header;
  }

  function showRemote(remote) {
    abortReads("detail");
    state.detailSeq += 1;
    state.detailLoading = false;
    state.detail = { kind: "remote", name: remote.name };
    setSidebar(false);
    const content = node("div", "view-content");
    content.append(metadata([["Fetch URL", remote.fetchUrl], ["Push URL", remote.pushUrl]]));
    content.append(node("p", "hint", "This view only displays remote settings; it does not make network requests. Fetch, pull, and push require explicit confirmation. Authentication and conflict errors are shown as reported by Git."));
    $("detail").replaceChildren(viewHeader("REMOTE", remote.name, "Remote settings", [button("Review fetch", `Review fetch from ${remote.name}`, () => prepareOperation("fetch", { remote: remote.name }))]), content);
    $("detail").focus({ preventScroll: true });
  }

  async function showHistory(query) {
    if (!state.repo || state.writePending) return;
    abortReads("detail");
    state.settings.tab = "history";
    state.settings.historyRef = query.ref || "HEAD";
    saveSettings({ tab: "history" });
    renderTabs();
    setSidebar(false);
    state.detailSeq += 1;
    state.detail = { kind: "history" };
    state.detailLoading = true;
    state.history = { query: { ref: query.ref || "HEAD", search: query.search || "", path: query.path || "" }, commits: [], skip: 0, hasMore: false, loading: true };
    renderHistory();
    $("detail").focus({ preventScroll: true });
    await loadHistoryPage(false);
  }

  async function loadHistoryPage(append) {
    if (!state.history || state.writePending) return;
    if (append && state.history.stale) return showHistory(state.history.query);
    const epoch = state.epoch;
    const sequence = ++state.historySeq;
    const history = state.history;
    const detailSequence = state.detailSeq;
    history.loading = true;
    if (state.detail.kind === "history") renderHistory();
    let finished = false;
    try {
      const result = await read("history", { ...history.query, skip: append ? history.skip : 0, limit: 80 });
      if (epoch !== state.epoch || sequence !== state.historySeq) return;
      const commits = append ? [...history.commits] : [];
      const seen = new Set(commits.map((commit) => commit.oid));
      for (const commit of result.commits) {
        if (!seen.has(commit.oid)) commits.push(commit);
        seen.add(commit.oid);
      }
      history.commits = commits;
      history.skip = (append ? history.skip : 0) + result.commits.length;
      history.hasMore = result.hasMore;
      history.stale = false;
      finished = true;
    } finally {
      if (epoch === state.epoch && sequence === state.historySeq) {
        history.loading = false;
        if (detailSequence === state.detailSeq && state.detail.kind === "history") {
          state.detailLoading = false;
          renderHistory();
          if (!finished) $("history-result-note").textContent = "Unable to finish loading. Retry using the error banner above. Previously loaded records remain available.";
        }
      }
    }
  }

  function historyFilters(query) {
    const form = node("form", "filter-bar");
    const scope = node("select");
    scope.id = "history-scope";
    scope.append(option("HEAD", "Current HEAD"), option("--all", "All branches"));
    for (const branch of state.snapshot?.branches || []) scope.append(option(branch.ref, branch.ref.replace(/^refs\/(heads|remotes)\//, "")));
    for (const tag of state.snapshot?.tags || []) scope.append(option(`refs/tags/${tag.name}`, `Tag · ${tag.name}`));
    if (![...scope.options].some((entry) => entry.value === query.ref)) scope.append(option(query.ref, query.ref));
    scope.value = query.ref;
    const search = node("input");
    search.id = "history-search";
    search.type = "search";
    search.placeholder = "Search commit messages (literal text)";
    search.value = query.search;
    const path = node("input");
    path.id = "history-path";
    path.placeholder = "Optional: repository-relative path";
    path.value = query.path;
    for (const [labelText, control] of [["Branch / ref", scope], ["Commit message · Literal match", search], ["File history", path]]) {
      const field = node("div", "filter-field");
      const label = node("label", "", labelText);
      label.htmlFor = control.id;
      field.append(label, control);
      form.append(field);
    }
    const submit = node("button", "", "Search");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(() => showHistory({ ref: scope.value, search: search.value, path: path.value }), "Search commit history");
    });
    return form;
  }

  function graphRows(commits) {
    let lanes = [];
    let width = 1;
    const rows = [];
    const positions = new Map(commits.map((commit, index) => [commit.oid, index]));
    let nonTopological = false;
    for (const [position, commit] of commits.entries()) {
      if (commit.parents.some((parent) => positions.has(parent) && positions.get(parent) <= position)) nonTopological = true;
      const before = lanes.slice();
      let column = before.indexOf(commit.oid);
      const incoming = column !== -1;
      if (column === -1) {
        column = before.indexOf(null);
        if (column === -1) column = before.length;
        before[column] = commit.oid;
      }
      const after = before.slice();
      after[column] = null;
      const links = [];
      for (const parent of [...new Set(commit.parents)]) {
        let next = after.indexOf(parent);
        if (next === -1) {
          next = after.indexOf(null);
          if (next === -1) next = after.length;
          after[next] = parent;
        }
        links.push({ from: column, to: next });
      }
      const continuing = [];
      before.forEach((oid, index) => {
        if (oid && oid !== commit.oid) continuing.push({ from: index, to: after.indexOf(oid) });
      });
      while (after.length && after.at(-1) === null) after.pop();
      width = Math.max(width, before.length, after.length);
      rows.push({ column, incoming, links, continuing, frontier: after.slice() });
      lanes = after;
    }
    return { rows, width, nonTopological };
  }

  function svgNode(tag, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function drawGraph(row, width, commit, last) {
    const svg = svgNode("svg", { viewBox: `0 0 ${width * 15 + 24} 72`, width: width * 15 + 24, height: 72, class: "commit-graph", role: "img", "aria-label": `Commit ${commit.shortOid}, parents: ${commit.parents.length}` });
    const x = (column) => 18 + column * 15;
    function line(from, to, top, bottom, column) {
      svg.append(svgNode("path", { d: `M ${x(from)} ${top} C ${x(from)} ${(top + bottom) / 2}, ${x(to)} ${(top + bottom) / 2}, ${x(to)} ${bottom}`, class: `graph-line graph-lane-${column % 4}` }));
    }
    for (const edge of row.continuing) line(edge.from, edge.to, 0, 72, edge.from);
    if (row.incoming) line(row.column, row.column, 0, 36, row.column);
    for (const edge of row.links) line(edge.from, edge.to, 36, 72, edge.to);
    svg.append(svgNode("circle", { cx: x(row.column), cy: 36, r: 4, class: `graph-node graph-loaded graph-lane-${row.column % 4}` }));
    if (last) row.frontier.forEach((oid, index) => {
      if (!oid) return;
      const circle = svgNode("circle", { cx: x(index), cy: 69, r: 2.5, class: `graph-node graph-lane-${index % 4}` });
      const title = svgNode("title", {});
      title.textContent = `Parent commit not loaded: ${oid}`;
      circle.append(title);
      svg.append(circle);
    });
    return svg;
  }

  function renderHistory() {
    const history = state.history;
    if (!history) return;
    const header = viewHeader("COMMIT HISTORY", history.query.path ? "File history" : "Commit history", history.query.path || "Browsing never switches branches. Edges show actual parents; hollow endpoints mark parents not yet loaded.");
    const list = node("ol", "history-list");
    const graph = graphRows(history.commits);
    const compact = graph.width > (window.matchMedia("(max-width: 480px)").matches ? 6 : 14) || graph.nonTopological;
    history.commits.forEach((commit, index) => {
      const row = node("li", "history-item");
      if (!compact) row.append(drawGraph(graph.rows[index], graph.width, commit, index === history.commits.length - 1));
      const main = button("", `View commit ${commit.shortOid}: ${commit.subject}`, () => showDetail({ kind: "commit", ref: commit.oid }), "history-main");
      const subject = node("span", "history-subject", commit.subject || "(No commit subject)");
      if (commit.refs) subject.append(node("span", "history-ref", commit.refs));
      const meta = node("span", "history-meta");
      meta.append(node("code", "", commit.shortOid), node("span", "", commit.author), node("span", "", formatDate(commit.date)));
      if (compact || commit.parents.length > 1) meta.append(node("span", "", `${commit.parents.length} parents`));
      main.append(subject, meta);
      row.append(main);
      list.append(row);
    });
    const footer = node("div", "history-footer");
    const note = node("p", "hint", history.loading ? "Loading commits..." : `${history.commits.length} commits${compact ? " · The graph is wide or not topologically ordered. Parent counts are shown instead; open a commit to inspect its actual parents." : ""}`);
    note.id = "history-result-note";
    footer.append(note);
    if (history.hasMore) {
      const more = button("Load more", "Load the next 80 commits", () => loadHistoryPage(true));
      more.disabled = history.loading;
      footer.append(more);
    }
    $("detail").replaceChildren(header, historyFilters(history.query), list);
    if (history.loading && !history.commits.length) $("detail").append(node("div", "loading", "Loading commit history..."));
    else if (!history.commits.length) {
      const empty = node("div", "empty-state");
      empty.append(node("h2", "", "No matching commits"), node("p", "", "Try another branch, clear the search filters, or create the first commit."));
      $("detail").append(empty);
    }
    $("detail").append(footer);
  }

  function detailRequest(descriptor) {
    switch (descriptor.kind) {
      case "commit": return ["commit", { ref: descriptor.ref }];
      case "diff": return ["diff", { path: descriptor.path, side: descriptor.side }];
      case "blame": return ["blame", { path: descriptor.path, ref: descriptor.ref || "HEAD" }];
      case "stash": return ["stash", { ref: descriptor.ref }];
      case "compare": return ["compare", { base: descriptor.base, target: descriptor.target }];
      default: throw new Error(`Unknown detail view: ${descriptor.kind}`);
    }
  }

  async function showDetail(descriptor) {
    if (!state.repo || state.writePending) return;
    const epoch = state.epoch;
    const sequence = ++state.detailSeq;
    state.detail = { ...descriptor };
    state.detailData = null;
    state.detailLoading = true;
    setSidebar(false);
    $("detail").replaceChildren(node("div", "loading", "Loading Git details..."));
    $("detail").focus({ preventScroll: true });
    const [view, args] = detailRequest(descriptor);
    const result = await read(view, args);
    if (epoch !== state.epoch || sequence !== state.detailSeq) return;
    state.detailData = result;
    state.detailLoading = false;
    renderDetail(result, descriptor);
  }

  async function reloadDetail() {
    if (!state.repo || state.writePending) return;
    if (state.detail.kind === "overview") {
      state.detailLoading = false;
      renderOverview();
    } else if (state.detail.kind === "history") {
      if (state.history) await showHistory(state.history.query);
      else await showHistory({ ref: state.settings.historyRef, search: "", path: "" });
    } else if (state.detail.kind === "remote") {
      const remote = state.snapshot?.remotes.find((entry) => entry.name === state.detail.name);
      if (remote) showRemote(remote);
      else {
        state.detail = { kind: "overview" };
        renderOverview();
      }
    } else await showDetail(state.detail);
  }

  function metadata(entries) {
    const list = node("dl", "metadata");
    for (const [key, value] of entries) list.append(node("dt", "", key), node("dd", "", value || "—"));
    return list;
  }

  function historyBackButton() {
    return button("← History", "Back to commit history", () => {
      if (!state.history || state.history.stale) return showHistory(state.history?.query || { ref: "HEAD", path: "", search: "" });
      abortReads("detail");
      state.detailSeq += 1;
      state.detailLoading = false;
      state.detail = { kind: "history" };
      renderHistory();
    });
  }

  function changedFiles(files, ref, deletedRef) {
    const details = section("Changed files · Click to view history", files.length, "detail:files", true, "changed-files");
    details.append(fileTree(files.map((file) => {
      const historicalRef = file.status.startsWith("D") ? deletedRef || ref : ref;
      return {
        ...file, status: file.status[0], title: `Browse history for ${file.path} at ${historicalRef}`,
        open: () => showHistory({ ref: historicalRef, path: file.path, search: "" }),
        actions: [{ label: "B", title: `View blame for ${file.path} at ${historicalRef}`, run: () => showDetail({ kind: "blame", path: file.path, ref: historicalRef }) }],
      };
    }), "detail:files"));
    if (!files.length) details.append(node("p", "tree-empty", "No changed files"));
    return details;
  }

  function renderDetail(result, descriptor) {
    const target = $("detail");
    target.replaceChildren();
    if (descriptor.kind === "commit") {
      target.append(viewHeader("COMMIT", result.subject || "(No commit subject)", result.oid, [historyBackButton()]));
      const content = node("section", "view-content");
      content.append(metadata([["Author", `${result.author} <${result.email}>`], ["Date", formatDate(result.date)]]));
      const parents = node("div", "toolbar");
      parents.append(node("span", "muted", result.parents.length ? "Parents" : "Root commit · No parents"));
      for (const parent of result.parents) parents.append(button(parent.slice(0, 12), `Browse parent ${parent}`, () => showDetail({ kind: "commit", ref: parent }), "text-button"));
      content.append(parents);
      if (result.body) content.append(node("pre", "commit-body", result.body));
      target.append(content, changedFiles(result.files, result.oid, result.parents[0]));
      renderDiff(target, result.diff);
    } else if (descriptor.kind === "diff") {
      const side = descriptor.side === "staged" ? "Staged · HEAD → Index" : "Working tree · Index → Working tree";
      const change = state.snapshot?.changes.find((entry) => entry.path === descriptor.path);
      const actions = [button(descriptor.side === "staged" ? "Unstage" : "Stage file", `${descriptor.side === "staged" ? "Unstage" : "Stage"} ${descriptor.path}`, () => prepareOperation(descriptor.side === "staged" ? "unstage" : "stage", { paths: pathsForChanges([change || { path: descriptor.path }]) }))];
      if (!change?.untracked) {
        const path = change?.originalPath || descriptor.path;
        actions.push(button("File history", `View history for ${path}`, () => showHistory({ ref: "HEAD", path, search: "" })));
        actions.push(button("Blame", `View blame for ${path} at HEAD`, () => showDetail({ kind: "blame", path, ref: "HEAD" })));
      }
      target.append(viewHeader("FILE DIFF", descriptor.path, side, actions));
      if (change?.conflict) target.append(node("div", "warning-box diff-limit", "This file has conflicts. Staging marks its current content as resolved. Check conflict markers and the final content first."));
      if (result.binary) target.append(node("div", "warning-box diff-limit", "Binary file: a line-by-line text diff is unavailable."));
      renderDiff(target, result.diff);
    } else if (descriptor.kind === "stash") {
      target.append(viewHeader("STASH", result.ref, "Read-only preview · Apply keeps the stash; Pop removes it after a successful apply.", [
        button("Review apply", `Apply ${result.ref}`, () => prepareOperation("stash_apply", { ref: result.ref })),
        button("Review pop", `Apply ${result.ref} and remove it on success`, () => prepareOperation("stash_pop", { ref: result.ref })),
      ]));
      renderDiff(target, result.diff);
    } else if (descriptor.kind === "compare") {
      target.append(viewHeader("COMPARE", `${result.base} → ${result.target}`, "Compare tree contents at two refs, not a merge-base or three-dot comparison.", [button("Edit comparison", "Change the refs being compared", openCompare)]));
      target.append(changedFiles(result.files, result.target, result.base));
      renderDiff(target, result.diff);
    } else if (descriptor.kind === "blame") {
      renderBlame(result, descriptor);
    }
  }

  function parseDiff(raw) {
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    return raw.split("\n").map((text) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return { kind: "hunk", text };
      }
      if (text.startsWith("diff --") || text.startsWith("@@@")) inHunk = false;
      if (inHunk && text.startsWith("+")) return { kind: "add", text: text.slice(1), old: "", new: newLine++, prefix: "+" };
      if (inHunk && text.startsWith("-")) return { kind: "delete", text: text.slice(1), old: oldLine++, new: "", prefix: "-" };
      if (inHunk && text.startsWith(" ")) return { kind: "context", text: text.slice(1), old: oldLine++, new: newLine++, prefix: " " };
      return { kind: "meta", text };
    });
  }

  function diffCode(line) {
    const cell = node("td", "diff-code");
    cell.append(node("span", "diff-prefix", line.prefix || " "), document.createTextNode(line.text));
    return cell;
  }

  function diffTable(lines, split) {
    const table = node("table", "diff-table");
    table.setAttribute("aria-label", split ? "Side-by-side diff: old version on the left, new version on the right" : "Unified diff: old line numbers, new line numbers, and patch");
    const body = node("tbody");
    table.append(body);
    function fullRow(line) {
      const row = node("tr", `diff-${line.kind}`);
      const cell = node("td", "diff-code", line.text);
      cell.colSpan = split ? 4 : 3;
      row.append(cell);
      body.append(row);
    }
    function pair(left, right) {
      const row = node("tr");
      for (const [line, side] of [[left, "old"], [right, "new"]]) {
        const number = node("td", `diff-number ${line ? `diff-${line.kind}` : "diff-placeholder"}`, line ? line[side] : "");
        const content = line ? diffCode(line) : node("td", "diff-placeholder");
        content.classList.add("diff-side");
        if (line) content.classList.add(`diff-${line.kind}`);
        row.append(number, content);
      }
      body.append(row);
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (["meta", "hunk"].includes(line.kind)) {
        fullRow(line);
      } else if (!split) {
        const row = node("tr", `diff-${line.kind}`);
        row.append(node("td", "diff-number", line.old), node("td", "diff-number", line.new), diffCode(line));
        body.append(row);
      } else if (line.kind === "context") {
        pair(line, line);
      } else {
        const removed = [];
        const added = [];
        while (index < lines.length && lines[index].kind === "delete") removed.push(lines[index++]);
        while (index < lines.length && lines[index].kind === "add") added.push(lines[index++]);
        index -= 1;
        for (let position = 0; position < Math.max(removed.length, added.length); position += 1) pair(removed[position], added[position]);
      }
    }
    return table;
  }

  function renderDiff(target, raw) {
    const wrapper = node("section", "diff-view");
    target.append(wrapper);
    const lines = parseDiff(raw);
    const added = lines.filter((line) => line.kind === "add").length;
    const deleted = lines.filter((line) => line.kind === "delete").length;
    const combined = raw.includes("\n@@@ ") || raw.startsWith("@@@ ");
    function draw() {
      wrapper.replaceChildren();
      const toolbar = node("div", "diff-toolbar");
      toolbar.append(node("span", "diff-stat", combined ? "Combined merge diff · Raw patch" : `+${added} / −${deleted} · Patch returned by the service`));
      const controls = node("div", "toolbar");
      for (const [mode, label] of [["unified", "Unified"], ["split", "Side by side"], ["raw", "Raw"]]) {
        const control = button(label, `Show ${label.toLowerCase()} diff`, () => {
          state.settings.diffMode = mode;
          saveSettings({ diffMode: mode });
          draw();
        });
        control.setAttribute("aria-pressed", String(state.settings.diffMode === mode));
        controls.append(control);
      }
      toolbar.append(controls);
      wrapper.append(toolbar);
      if (!raw) {
        wrapper.append(node("div", "empty-state", "No text diff to display. The file may be unchanged, identical, or represented by a patch without text."));
        return;
      }
      if (state.settings.diffMode === "raw") {
        wrapper.append(node("p", "hint diff-limit", "The full patch returned by the service is shown with whitespace preserved, including any server-side truncation markers."));
        const original = node("pre", "diff-raw", raw);
        original.tabIndex = 0;
        original.setAttribute("aria-label", "Full raw patch, horizontally scrollable");
        wrapper.append(original);
        return;
      }
      if (combined) wrapper.append(node("p", "warning-box diff-limit", "This is a combined merge diff and cannot be aligned as a two-way patch. Original lines are preserved. Select Raw to view all content."));
      if (state.settings.diffMode === "split") wrapper.append(node("p", "hint diff-limit", "Left: old version · Right: new version. Adjacent additions and deletions are paired by order, not by semantic similarity."));
      const limit = 4000;
      if (lines.length > limit) {
        const warning = node("div", "warning-box diff-limit", `For responsiveness, the highlighted view shows only the first ${limit.toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")} lines.`);
        warning.append(button("View full raw patch", "View the complete raw patch returned by the service", () => {
          state.settings.diffMode = "raw";
          saveSettings({ diffMode: "raw" });
          draw();
        }, "text-button"));
        wrapper.append(warning);
      }
      const scroller = node("div", "diff-scroll");
      scroller.tabIndex = 0;
      scroller.setAttribute("aria-label", "Diff content, horizontally scrollable");
      scroller.append(diffTable(lines.slice(0, limit), state.settings.diffMode === "split" && !combined));
      wrapper.append(scroller);
    }
    draw();
  }

  function renderBlame(result, descriptor) {
    const target = $("detail");
    target.append(viewHeader("BLAME", result.path, `Ref: ${descriptor.ref || "HEAD"} · Showing the committed version, without uncommitted working tree changes.`, [
      button("File history", `View file history for ${result.path}`, () => showHistory({ ref: descriptor.ref || "HEAD", path: result.path, search: "" })),
    ]));
    if (result.truncated) target.append(node("p", "warning-box diff-limit", "Blame results were truncated by the service. Only the returned lines are shown, not the complete file."));
    if (!result.lines.length) {
      target.append(node("div", "empty-state", "This version has no text lines to display."));
      return;
    }
    const scroller = node("div", "blame-scroll");
    scroller.tabIndex = 0;
    scroller.setAttribute("aria-label", "Blame content, horizontally scrollable");
    const table = node("table", "blame-table");
    table.setAttribute("aria-label", "Commit attribution, file line numbers, and code");
    const body = node("tbody");
    let previous = "";
    for (const line of result.lines) {
      const row = node("tr", previous === line.oid ? "blame-repeat" : "");
      const info = node("td", "blame-meta");
      if (previous !== line.oid) {
        const commit = button(line.oid.slice(0, 9), `${line.summary}\n${line.oid}`, () => showDetail({ kind: "commit", ref: line.oid }), "text-button");
        commit.disabled = /^0+$/.test(line.oid);
        info.append(commit, node("span", "blame-author", `${line.author} · ${formatDate(line.date)}`));
        info.title = line.summary;
      }
      const number = node("td", "blame-number", line.line);
      number.title = `Original line number: ${line.originalLine}`;
      row.append(info, number, node("td", "blame-code", line.text));
      body.append(row);
      previous = line.oid;
    }
    table.append(body);
    scroller.append(table);
    target.append(scroller);
  }

  function openModal({ title, description, submitLabel, body, submit, kind = "input" }) {
    if (!$("modal").open) state.returnFocus = document.activeElement;
    state.modal = { submit, kind, busy: false };
    $("modal-title").textContent = title;
    $("modal-description").textContent = description;
    $("modal-body").replaceChildren(...body);
    $("modal-error").hidden = true;
    $("modal-error").textContent = "";
    $("modal-submit").textContent = submitLabel;
    $("modal-submit").disabled = false;
    $("modal-cancel").disabled = false;
    $("modal-cancel").textContent = kind === "postwrite" ? "Close" : "Cancel";
    $("modal-eyebrow").textContent = kind === "confirmation" ? "REVIEW BEFORE EXECUTION" : "GIT WORKBENCH";
    if (!$("modal").open) $("modal").showModal();
    syncControls();
    const focus = kind === "confirmation" ? $("modal-cancel") : $("modal-body").querySelector("input, textarea, select") || $("modal-cancel");
    focus.focus();
  }

  function closeModal(force = false) {
    if (!force && (state.executing || state.modal?.busy)) return;
    const hadWrite = state.writePending || state.modal?.kind === "reprepare";
    state.modal = null;
    state.writePending = false;
    $("modal").close();
    syncControls();
    if (state.returnFocus?.isConnected) state.returnFocus.focus();
    if (hadWrite && !force) run(() => refreshAll(), "Refresh status after cancellation");
  }

  function field(labelText, id, { value = "", placeholder = "", required = false, multiline = false } = {}) {
    const wrapper = node("div", "modal-field");
    const label = node("label", "", labelText);
    label.htmlFor = id;
    const input = node(multiline ? "textarea" : "input");
    input.id = id;
    input.value = value;
    input.placeholder = placeholder;
    input.required = required;
    if (!multiline) input.type = "text";
    input.autocomplete = "off";
    wrapper.append(label, input);
    return { wrapper, input };
  }

  function openAddRepository() {
    const path = field("Absolute repository path", "repository-path", { placeholder: "C:\\code\\my-project", required: true });
    openModal({
      title: "Add local repository", description: "Enter the full path of an existing Git working tree. This does not clone, create, or modify a repository.", submitLabel: "Add and open",
      body: [path.wrapper, node("p", "hint", "Existing worktrees are supported. The repository list is saved by the local service, independently of this panel.")],
      submit: async () => {
        if (await addAndOpenRepository(path.input.value.trim())) closeModal(true);
      },
    });
  }

  async function addAndOpenRepository(path) {
    if (!path) throw new Error("Enter an absolute repository path.");
    const catalog = await api({ action: "add_repository", path });
    state.repositories = catalog.repositories;
    renderCatalog();
    const comparablePath = (value) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const exact = catalog.repositories.find((repo) => comparablePath(repo.path) === comparablePath(path));
    const entry = exact || (catalog.repositories.length === 1 ? catalog.repositories[0] : null);
    if (entry) {
      await selectRepository(entry.path, { remember: true });
      return true;
    }
    if (!catalog.repositories.length) throw new Error("Repository registration returned an empty list. Refresh the repository list and retry.");
    // A catalog alone cannot identify an existing symlink's target among multiple roots.
    // Ask for a returned root instead of guessing from prefixes or newly appearing entries.
    const wrapper = node("div", "modal-field");
    const label = node("label", "", "Registered repository root");
    const select = node("select");
    select.id = "canonical-repository";
    select.required = true;
    label.htmlFor = select.id;
    const placeholder = option("", "Select the repository root to open");
    placeholder.disabled = true;
    select.append(placeholder, ...catalog.repositories.map((repo) => option(repo.path, `${repo.name} · ${repo.path}`)));
    select.value = "";
    wrapper.append(label, select);
    openModal({
      title: "Select the resolved repository",
      description: "The path was validated and registered. A subdirectory or symlink may resolve to an existing repository. Select the returned root to ensure the correct repository opens.",
      submitLabel: "Open selected repository",
      body: [node("p", "confirmation-repo", `Entered path: ${path}`), wrapper],
      submit: async () => {
        const selected = catalog.repositories.find((repo) => repo.path === select.value);
        if (!selected) throw new Error("Select a repository root from the list.");
        await selectRepository(selected.path, { remember: true });
        closeModal(true);
      },
    });
    return false;
  }

  function openRemoveRepository() {
    const repo = state.repo;
    openModal({
      title: "Remove this repository from the list?", description: "Only the Git Workbench registration will be removed. Files on disk and Git state will not change.", submitLabel: "Remove from list only",
      body: [node("p", "confirmation-repo", repo)],
      submit: async () => {
        const catalog = await api({ action: "remove_repository", repo });
        state.repositories = catalog.repositories;
        closeModal(true);
        await selectRepository(catalog.lastSelectedRepo || "");
        showNotice("Repository removed from the list. Files on disk were preserved.");
      },
    });
  }

  function openCreateBranch() {
    const name = field("New branch name", "branch-name", { required: true, placeholder: "feature/my-change" });
    const start = field("Starting point (optional)", "branch-start", { placeholder: "Defaults to current HEAD" });
    openModal({
      title: "Create and switch branch", description: "This action creates a local branch and switches the checkout. The next step shows the exact commands.", submitLabel: "Preview commands",
      body: [name.wrapper, start.wrapper],
      submit: () => prepareOperation("create_branch", { name: name.input.value.trim(), ...(start.input.value.trim() ? { startPoint: start.input.value.trim() } : {}) }),
    });
  }

  function openStash() {
    const message = field("Stash message (optional)", "stash-message", { placeholder: "Save current work temporarily" });
    const include = node("input");
    include.type = "checkbox";
    include.id = "stash-untracked";
    const label = node("label", "modal-check");
    label.htmlFor = include.id;
    label.append(include, document.createTextNode("Include untracked files (excluding ignored files)"));
    openModal({
      title: "Create stash", description: "Save staged and working tree changes, then remove them from the working tree. Nothing runs automatically.", submitLabel: "Preview commands",
      body: [message.wrapper, label],
      submit: () => prepareOperation("stash_push", { ...(message.input.value ? { message: message.input.value } : {}), includeUntracked: include.checked }),
    });
  }

  function openCompare() {
    const base = field("Base · Old version", "compare-base", { required: true, value: state.detail.kind === "compare" ? state.detail.base : state.snapshot?.upstream || "HEAD~1" });
    const target = field("Target · New version", "compare-target", { required: true, value: state.detail.kind === "compare" ? state.detail.target : "HEAD" });
    openModal({
      title: "Compare two refs", description: "Compare two trees without changing them. Enter a branch, tag, or commit ID. No merge or branch switch will occur.", submitLabel: "View diff",
      body: [base.wrapper, target.wrapper],
      submit: async () => {
        const descriptor = { kind: "compare", base: base.input.value.trim(), target: target.input.value.trim() };
        closeModal(true);
        await showDetail(descriptor);
      },
    });
  }

  async function prepareOperation(operation, params) {
    if (!state.repo) throw new Error("Select a repository first.");
    if (state.writePending) throw new Error("Another Git operation is awaiting confirmation. Cancel or complete it first.");
    const repo = state.repo;
    state.writePending = true;
    syncControls();
    let prepared = false;
    try {
      const confirmation = await api({ action: "prepare", repo, operation, params });
      const body = [
        node("p", "confirmation-repo", repo),
        node("p", "confirmation-summary", confirmation.summary),
        node("h3", "", "Exact commands to run"),
        node("pre", "command-preview", confirmation.commands.join("\n")),
      ];
      if (operation === "commit") {
        body.unshift(node("div", "warning-box", "Staged changes only: this commit includes ALL staged content in the repository, regardless of selected files or path filters. Unstaged changes will not be staged automatically."));
        body.push(node("h3", "", "Full commit message"), node("pre", "command-preview", params.message));
      }
      if (operation === "stage" && state.snapshot?.changes.some((change) => change.conflict)) body.push(node("div", "warning-box", "The repository has conflicts. Staging a conflicted file marks its current content as resolved. Make sure the content is correct."));
      if (operation === "stash_pop") body.push(node("div", "warning-box", "Pop applies the stash and removes it on success. If conflicts occur, follow the Git output to resolve them."));
      if (confirmation.warning) body.push(node("div", "warning-box", confirmation.warning));
      body.push(node("p", "hint", `Confirmation expires at ${formatDate(confirmation.expiresAt)}. If state changes or the preview expires, prepare a new preview and confirm again.`));
      openModal({
        title: confirmation.title, description: "Review the target repository, commands, and effects. Git state changes only after you click Confirm and run.", submitLabel: "Confirm and run",
        body, kind: "confirmation", submit: () => executePrepared(confirmation, operation, params),
      });
      state.modal.operation = operation;
      prepared = true;
    } finally {
      if (!prepared) {
        state.writePending = false;
        syncControls();
      }
    }
  }

  async function executePrepared(confirmation, operation, params) {
    abortReads();
    state.snapshotSeq += 1;
    state.filesSeq += 1;
    state.historySeq += 1;
    state.detailSeq += 1;
    state.executing = true;
    renderStatus();
    let executed = false;
    try {
      const result = await api({ action: "execute", confirmationId: confirmation.confirmationId });
      executed = true;
      state.snapshot = result.snapshot;
      completeWriteState(operation);
      if (state.modal) state.modal.kind = "completed";
      closeModal(true);
      renderSnapshot();
      showNotice(`${confirmation.title} · Completed`, result.output);
    } finally {
      state.executing = false;
      state.writePending = false;
      if (!executed && state.modal) {
        // A confirmation is single-use. Retry can only prepare a NEW preview, never execute again.
        state.modal.kind = "reprepare";
        state.modal.submit = () => prepareOperation(operation, params);
        $("modal-submit").textContent = "Prepare a new confirmation";
      }
      syncControls();
    }
    await refreshAll();
  }

  function completeWriteState(operation) {
    if (state.history) {
      state.history.loading = false;
      state.history.stale = true;
    }
    if (operation === "commit") {
      $("commit-message").value = "";
      state.drafts.delete(state.repo);
    }
    state.selections = { staged: new Set(), working: new Set(), conflicts: new Set() };
  }

  function showPostWriteRefresh(error, operation) {
    completeWriteState(operation);
    state.snapshot = null;
    state.detailLoading = false;
    $("head-badge").textContent = "Status needs refresh";
    $("changes-count").textContent = "—";
    $("sync-summary").textContent = "Git completed; status refresh failed";
    $("reference-trees").replaceChildren(node("p", "tree-empty", "Ref status needs refresh"));
    $("change-trees").replaceChildren(node("p", "tree-empty", "Status unknown. Refresh the repository first."));
    state.files = null;
    $("files-tree").replaceChildren();
    $("files-note").textContent = "File list needs refresh";
    const pending = node("div", "empty-state");
    pending.append(node("h2", "", "Git completed; only a refresh is needed"), node("p", "", "The previous command completed. No commit, push, or other write operation will be repeated."));
    pending.append(button("Refresh status only", "Read repository status without repeating the Git operation", refreshAll, "primary"));
    $("detail").replaceChildren(pending);
    showNotice("Git completed, but the follow-up refresh failed. Refresh status only; do not repeat the write operation.", error.message);
    openModal({
      title: "Git completed; refresh failed",
      description: "The service confirmed that the command completed. Do not retry the write operation. The button below only reads repository status; it does not run the command again.",
      submitLabel: "Refresh status only",
      kind: "postwrite",
      body: [node("p", "confirmation-repo", state.repo), node("pre", "command-preview", error.message)],
      submit: async () => {
        const issue = state.error;
        await refreshAll();
        closeModal(true);
        if (state.error === issue) clearError();
        showNotice("Repository status refreshed. The completed Git operation was not repeated.", error.message);
      },
    });
    showError(error, "Git completed; only the refresh failed", refreshAll, "Refresh status only");
  }

  async function submitModal(event) {
    event.preventDefault();
    const modal = state.modal;
    if (!modal || modal.busy) return;
    modal.busy = true;
    $("modal-submit").disabled = true;
    $("modal-cancel").disabled = true;
    $("modal-error").hidden = true;
    let generation = state.detailSeq;
    try {
      const result = modal.submit();
      generation = state.detailSeq;
      await result;
    } catch (error) {
      if (error.name === "AbortError") return;
      if (error.code === "refresh_failed_after_write") {
        showPostWriteRefresh(error, modal.operation);
        return;
      }
      const readOnlyRetry = ["completed", "postwrite"].includes(modal.kind);
      showError(error, readOnlyRetry ? "Git completed; follow-up read failed" : "Read or operation did not complete",
        state.modal && !readOnlyRetry ? null : refreshAll, readOnlyRetry ? "Refresh status only" : "Retry");
      if (state.modal) {
        $("modal-error").hidden = false;
        $("modal-error").textContent = errorText(error);
      }
      if (state.detailLoading && (generation === state.detailSeq || !state.snapshot)) {
        state.detailLoading = false;
        const empty = node("div", "empty-state");
        empty.append(node("h2", "", "Unable to load content"), node("p", "", "The error remains visible. Retry or switch repositories."));
        empty.append(button("Reload", "Reload the current repository and view", refreshAll));
        $("detail").replaceChildren(empty);
      }
    } finally {
      modal.busy = false;
      if (state.modal) {
        $("modal-submit").disabled = false;
        $("modal-cancel").disabled = false;
      }
      syncControls();
    }
  }

  function bind(id, event, action, label) {
    $(id).addEventListener(event, (eventObject) => {
      if (event === "submit") eventObject.preventDefault();
      run(() => action(eventObject), label);
    });
  }

  function bindEvents() {
    bind("sidebar-toggle", "click", () => setSidebar(!$("app").classList.contains("sidebar-open")), "Toggle navigation");
    bind("repo-select", "change", () => selectRepository($("repo-select").value, { remember: true }), "Open repository");
    bind("add-repo", "click", openAddRepository, "Add repository");
    bind("welcome-add", "click", openAddRepository, "Add repository");
    bind("remove-repo", "click", openRemoveRepository, "Remove repository registration");
    bind("refresh", "click", () => state.bootstrap ? refreshAll() : initialize(), "Refresh repository");
    bind("fetch", "click", () => prepareOperation("fetch", { remote: $("remote-select").value }), "Review fetch");
    bind("pull", "click", () => prepareOperation("pull", {}), "Review pull (fast-forward only)");
    bind("push", "click", () => prepareOperation("push", {}), "Review push (existing upstream)");
    bind("remote-select", "change", () => { state.settings.remote = $("remote-select").value; saveSettings({ remote: state.settings.remote }); }, "Save remote preference");
    bind("branch-create", "click", openCreateBranch, "Create branch");
    bind("stash-create", "click", openStash, "Create stash");
    bind("compare-open", "click", openCompare, "Compare refs");
    bind("commit-message", "input", () => {
      state.drafts.set(state.repo, $("commit-message").value);
      syncControls();
    }, "Edit commit message");
    bind("commit-form", "submit", () => {
      const message = $("commit-message").value;
      if (!message.trim()) throw new Error("Enter a commit message.");
      return prepareOperation("commit", { message });
    }, "Review commit");
    for (const tab of ["changes", "history", "files"]) bind(`tab-${tab}`, "click", () => setTab(tab), "Switch browse view");
    bind("history-head", "click", () => showHistory({ ref: "HEAD", path: "", search: "" }), "Load history at HEAD");
    bind("history-all", "click", () => showHistory({ ref: "--all", path: "", search: "" }), "Load history across all branches");
    bind("change-filter", "input", () => {
      state.settings.changeFilter = $("change-filter").value;
      saveSettings({ changeFilter: state.settings.changeFilter });
      renderChanges();
    }, "Filter changed paths");
    bind("file-search", "input", () => {
      state.settings.fileSearch = $("file-search").value;
      state.filesSeq += 1;
      saveSettings({ fileSearch: state.settings.fileSearch });
      clearTimeout(state.fileTimer);
      state.fileTimer = setTimeout(() => run(loadFiles, "Search tracked files"), 300);
    }, "Filter files");
    bind("auto-refresh", "change", () => {
      state.settings.autoRefresh = $("auto-refresh").checked;
      saveSettings({ autoRefresh: state.settings.autoRefresh });
    }, "Save refresh preference");
    bind("error-dismiss", "click", clearError, "Dismiss error");
    bind("error-retry", "click", async () => {
      const error = state.error;
      if (!error?.retry || error.repo && error.repo !== state.repo) return;
      if (await run(error.retry, error.title, error.retry, error.retryLabel) && state.error === error) clearError();
    }, "Retry");
    $("modal-form").addEventListener("submit", submitModal);
    $("modal-cancel").addEventListener("click", () => closeModal());
    $("modal").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !state.modal) setSidebar(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && canAutoRefresh()) run(refreshSnapshot, "Refresh when returning to the page");
    });
    setInterval(() => {
      if (state.settings.autoRefresh && canAutoRefresh()) run(refreshSnapshot, "Auto-refresh repository");
    }, 15000);
  }

  function canAutoRefresh() {
    const active = document.activeElement;
    return Boolean(state.repo && document.visibilityState === "visible" && !state.writePending && !state.modal && !state.pending &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName));
  }

  async function initialize() {
    const bootstrap = JSON.parse($("bootstrap").textContent);
    if (!bootstrap || typeof bootstrap.token !== "string" || !bootstrap.token) throw new Error("A valid connection token is missing. Reopen Git Workbench from the host app.");
    state.bootstrap = bootstrap;
    await refreshCatalog();
    await selectRepository(bootstrap.initialRepo || "");
  }

  bindEvents();
  run(initialize, "Connect to Git Workbench");
})();
