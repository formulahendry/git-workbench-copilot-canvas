import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { defaultPreferences, preferenceLimits, validatePreferences } from "./preferences.mjs";
import { RepositoryStore } from "./store.mjs";
import { GitService, runGit } from "./git.mjs";
import { startServer } from "./server.mjs";
import { initialContext } from "./context.mjs";

async function fixture(t) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-workbench-preferences-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repos = [path.join(root, "demo-one"), path.join(root, "demo-two")];
    for (const repo of repos) {
        await mkdir(repo);
        await runGit(repo, ["init", "--initial-branch=main"]);
    }
    const directory = path.join(root, "isolated-data");
    const store = new RepositoryStore(directory);
    for (const repo of repos) await store.add(repo);
    return { root, repos, directory, store };
}

function api(server) {
    const url = new URL(server.url);
    return async (data, headers = {}) => {
        const response = await fetch(new URL("/api", url), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Git-Workbench-Token": url.searchParams.get("token"), ...headers },
            body: JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
    };
}

test("preference allowlist rejects transient state, invalid values and prototype keys", () => {
    assert.deepEqual(validatePreferences(defaultPreferences()), defaultPreferences());
    const expanded = Object.fromEntries(Array.from({ length: preferenceLimits.expanded }, (_, i) => [`folder:${i}`, true]));
    assert.deepEqual(validatePreferences({ expanded }).expanded, expanded);
    for (const invalid of [
        null, [], "text", { tab: "admin" }, { diffMode: "html" }, { autoRefresh: "true" },
        { token: "capability" }, { confirmationId: "plan" }, { historyRef: "old-branch" }, { commitMessage: "draft" },
        { instanceId: "panel" }, { arbitrary: {} }, { fileSearch: "x".repeat(513) },
        { remote: "x".repeat(1025) }, { changeFilter: "line\nbreak" }, { remote: "\0" },
        { expanded: [] }, { expanded: { item: 1 } }, { expanded: { "": true } },
        { expanded: { ...expanded, overflow: true } },
        { expanded: { ["x".repeat(1025)]: true } },
        JSON.parse('{"__proto__":{"polluted":true}}'),
        JSON.parse('{"expanded":{"__proto__":true}}'), { expanded: { constructor: true } },
    ]) assert.throws(() => validatePreferences(invalid), { code: "invalid_preferences" });
    assert.equal({}.polluted, undefined);
    const source = { expanded: { folder: true } };
    const validated = validatePreferences(source);
    source.expanded.folder = false;
    assert.equal(validated.expanded.folder, true, "queued patches must not retain mutable input");
});

test("version 1 catalogs gain repo-scoped preferences without losing manual selection", async (t) => {
    const { repos: [first, second], directory, store } = await fixture(t);
    await store.remember(second);
    assert.deepEqual(await store.getPreferences(first), defaultPreferences());
    await store.setPreferences(first, { tab: "history", diffMode: "split", expanded: { "refs:local": false } });
    const reopened = new RepositoryStore(directory);
    assert.equal((await reopened.catalog()).version, 1);
    assert.equal((await reopened.catalog()).lastSelectedRepo, second);
    assert.equal((await reopened.getPreferences(first)).diffMode, "split");
    assert.equal((await reopened.getPreferences(first)).expanded["refs:local"], false);
    assert.deepEqual(await reopened.getPreferences(second), defaultPreferences());
    const session = await initialContext({ workingDirectory: first }, reopened);
    assert.equal(session.initialRepo, first);
    assert.equal(session.source, "session");
    assert.equal((await reopened.catalog()).lastSelectedRepo, second);
    const persisted = await readFile(store.file, "utf8");
    assert.doesNotMatch(persisted, /historyRef|confirmationId|token|instanceId|commitMessage/);
    await reopened.remove(first);
    await reopened.add(first);
    assert.deepEqual(await reopened.getPreferences(first), defaultPreferences());
});

test("preferences merge distinct fields across store instances and serialize same-field writes", async (t) => {
    const { repos: [repo], directory, store } = await fixture(t);
    const second = new RepositoryStore(directory);
    await Promise.all([
        store.setPreferences(repo, { tab: "files" }),
        second.setPreferences(repo, { autoRefresh: true }),
        store.setPreferences(repo, { diffMode: "raw" }),
    ]);
    assert.deepEqual(await second.getPreferences(repo), {
        ...defaultPreferences(), tab: "files", autoRefresh: true, diffMode: "raw",
    });
    const firstWrite = store.setPreferences(repo, { fileSearch: "earlier" });
    await firstWrite;
    await store.setPreferences(repo, { fileSearch: "latest" });
    assert.equal((await second.getPreferences(repo)).fileSearch, "latest");
    const before = await readFile(store.file, "utf8");
    await assert.rejects(store.setPreferences(repo, { historyRef: "stale" }), { code: "invalid_preferences" });
    assert.equal(await readFile(store.file, "utf8"), before);
    await store.remove(repo);
    await assert.rejects(store.setPreferences(repo, { tab: "files" }), { code: "repository_not_registered" });
});

test("invalid persisted preferences fail visibly instead of overwriting the catalog", async (t) => {
    const { store } = await fixture(t);
    const catalog = await store.catalog();
    catalog.repositories[0].preferences = { tab: "unknown" };
    const corrupt = JSON.stringify(catalog);
    await writeFile(store.file, corrupt);
    await assert.rejects(store.catalog(), { code: "invalid_preferences" });
    await assert.rejects(store.remember(catalog.repositories[0].path), { code: "invalid_preferences" });
    assert.equal(await readFile(store.file, "utf8"), corrupt);
    await writeFile(store.file, "null");
    await assert.rejects(store.catalog(), { code: "catalog_invalid" });
});

test("authenticated preferences survive a new server, port, token and store instance", async (t) => {
    const { repos: [repo, other], store, directory } = await fixture(t);
    const service = new GitService();
    const first = await startServer({ store, service, initialRepo: repo });
    const second = await startServer({ store: new RepositoryStore(directory), service, initialRepo: repo });
    t.after(async () => { await first.close(); await second.close(); });
    assert.notEqual(new URL(first.url).port, new URL(second.url).port);
    const request = api(first);
    const saved = await request({ action: "set_preferences", repo, preferences: { tab: "history", diffMode: "split", changeFilter: "src" } });
    assert.equal(saved.status, 200);
    assert.equal((await api(second)({ action: "get_preferences", repo })).body.diffMode, "split");
    assert.deepEqual((await api(second)({ action: "get_preferences", repo: other })).body, defaultPreferences());
    assert.equal((await request({ action: "set_preferences", repo, preferences: { autoRefresh: true } }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await api(second)({ action: "get_preferences", repo }, {
        "X-Git-Workbench-Token": new URL(first.url).searchParams.get("token"),
    })).status, 403);
    assert.equal((await request({ action: "set_preferences", repo, preferences: { token: "not-persisted" } })).body.error.code, "invalid_preferences");
    assert.equal((await request({ action: "get_preferences", repo })).body.autoRefresh, false);
    const script = await fetch(new URL("preferences.mjs", first.url));
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.match(await script.text(), /export function validatePreferences/);
    assert.match(await (await fetch(first.url)).text(), /src="app.js" type="module"/);
    assert.doesNotMatch(await readFile(store.file, "utf8"), /token|not-persisted|confirmation/);
});

test("a successful write with a failed refresh cannot reuse its confirmation", async (t) => {
    const { store, repos: [repo] } = await fixture(t);
    let executions = 0;
    const service = {
        prepare: async () => ({ repo, commands: [["add", "--", "demo.txt"]], title: "Stage demo", summary: "Fixture only" }),
        execute: async () => { executions++; return { output: "Completed fixture operation" }; },
        snapshot: async () => { throw new Error("Fixture refresh failure"); },
    };
    const server = await startServer({ service, store });
    t.after(() => server.close());
    const request = api(server);
    const preview = await request({ action: "prepare", repo, operation: "stage", params: {} });
    const failed = await request({ action: "execute", confirmationId: preview.body.confirmationId });
    assert.equal(failed.body.error.code, "refresh_failed_after_write");
    assert.match(failed.body.error.message, /Git completed/);
    assert.equal((await request({ action: "execute", confirmationId: preview.body.confirmationId })).body.error.code, "confirmation_expired");
    assert.equal(executions, 1);
});

async function uiHarness(intercept = async () => undefined) {
    const elements = new Map();
    const element = () => ({
        value: "", hidden: false, disabled: false, children: [],
        classList: { toggle() {} }, setAttribute() {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
    });
    const requests = [];
    const preferences = new Map();
    let context;
    context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            createElement: element,
        },
        clearTimeout, AbortController,
        fetch: async (_url, options) => {
            const request = JSON.parse(options.body);
            requests.push(request);
            let result = await intercept(request);
            if (result === undefined && request.action === "get_preferences") result = { ...defaultPreferences(), ...preferences.get(request.repo) };
            if (result === undefined && request.action === "set_preferences") {
                result = { ...preferences.get(request.repo), ...request.preferences };
                preferences.set(request.repo, result);
            }
            // Model response.json() in the browser's own realm.
            return { ok: !result?.error, json: async () => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(result || {}))})`, context) };
        },
    });
    const shared = (await readFile(new URL("./preferences.mjs", import.meta.url), "utf8")).replace(/^export /gm, "");
    const source = (await readFile(new URL("./app.js", import.meta.url), "utf8"))
        .replace(/^import .* from "\.\/preferences\.mjs";\r?\n/m, "")
        .replace(/  bindEvents\(\);\r?\n  run\(initialize, "Connect to Git Workbench"\);/,
            '  refreshSnapshot = async () => {};\n  globalThis.ui = { state, saveSettings, selectRepository };');
    assert.ok(source.includes("globalThis.ui ="), "UI test entrypoint must replace browser startup");
    vm.runInContext(shared + "\n" + source, context);
    vm.runInContext('ui.state.bootstrap = { token: "fixture-token" };', context);
    return { context, requests, preferences, evaluate: (source) => vm.runInContext(source, context) };
}

test("UI queues captured repo patches, restores preferences and always starts history at HEAD", async () => {
    const ui = await uiHarness();
    ui.preferences.set("demo-one", { tab: "history", diffMode: "split", expanded: { "refs:local": false } });
    await ui.evaluate('ui.selectRepository("demo-one")');
    assert.equal(ui.evaluate("ui.state.settings.historyRef"), "HEAD");
    assert.equal(ui.evaluate("ui.state.settings.diffMode"), "split");
    assert.equal(ui.evaluate('ui.state.settings.expanded["refs:local"]'), false);
    ui.evaluate('ui.state.settings.historyRef = "old-branch"; ui.saveSettings({ autoRefresh: true });');
    await ui.evaluate('ui.selectRepository("demo-two")');
    assert.equal(ui.preferences.get("demo-one").autoRefresh, true);
    assert.equal(ui.preferences.get("demo-two"), undefined);
    assert.equal(ui.evaluate("ui.state.settings.historyRef"), "HEAD");
    assert.equal(ui.evaluate("ui.state.settings.diffMode"), "unified");
    await ui.evaluate('ui.selectRepository("demo-one")');
    assert.equal(ui.evaluate("ui.state.settings.historyRef"), "HEAD");
    assert.equal(ui.evaluate("ui.state.settings.autoRefresh"), true);
    const writes = ui.requests.filter((request) => request.action === "set_preferences");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].preferences, { autoRefresh: true });
    assert.doesNotMatch(JSON.stringify(ui.preferences.get("demo-one")), /historyRef|token|confirmation|instanceId/);
});

test("obsolete preference loads cannot replace a newer repository selection", async () => {
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    let started;
    const loading = new Promise((resolve) => { started = resolve; });
    const ui = await uiHarness(async (request) => {
        if (request.action === "get_preferences" && request.repo === "slow-demo") {
            started();
            await delayed;
        }
    });
    ui.preferences.set("slow-demo", { diffMode: "raw" });
    const slow = ui.evaluate('ui.selectRepository("slow-demo")');
    await loading;
    await ui.evaluate('ui.selectRepository("current-demo")');
    release();
    await slow;
    assert.equal(ui.evaluate("ui.state.repo"), "current-demo");
    assert.equal(ui.evaluate("ui.state.settings.diffMode"), "unified");
});

test("preference failures stay visible, are never retried, and do not poison later saves", async () => {
    let fail = true;
    const ui = await uiHarness(async (request) => {
        if (fail && request.action === "set_preferences") {
            return { error: { code: "catalog_locked", message: "Fixture catalog is locked" } };
        }
    });
    await ui.evaluate('ui.selectRepository("demo")');
    ui.evaluate('ui.saveSettings({ autoRefresh: true });');
    await ui.evaluate("ui.state.preferenceWrites");
    assert.equal(ui.evaluate("ui.state.error.error.code"), "catalog_locked");
    assert.equal(ui.evaluate("ui.state.error.retry"), null);
    assert.equal(ui.preferences.get("demo"), undefined);
    fail = false;
    ui.evaluate('ui.saveSettings({ diffMode: "split" });');
    await ui.evaluate("ui.state.preferenceWrites");
    assert.deepEqual(ui.preferences.get("demo"), { diffMode: "split" });
    assert.equal(ui.requests.filter((request) => request.action === "set_preferences").length, 2);
});
