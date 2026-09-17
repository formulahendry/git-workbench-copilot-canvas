import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { GitService, runGit } from "../extensions/git-workbench/git.mjs";
import { RepositoryStore } from "../extensions/git-workbench/store.mjs";
import { startServer } from "../extensions/git-workbench/server.mjs";

const browser = process.argv[2];
if (!browser || !path.isAbsolute(browser)) throw new Error("Usage: node tests/browser-smoke.mjs <absolute Chromium executable> [screenshot.png]");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = path.join(root, ".tmp");
await mkdir(temporary, { recursive: true });
const fixture = await mkdtemp(path.join(temporary, "browser-demo-"));
const repo = path.join(fixture, "aurora-demo");
const servers = [];
let child, socket;
const pending = new Map();

try {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await runGit(repo, ["init", "--initial-branch=main"]);
    for (const [key, value] of [
        ["user.name", "Demo Author"], ["user.email", "demo@example.invalid"],
        ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", path.join(fixture, "no-hooks")],
    ]) await runGit(repo, ["config", key, value]);
    await writeFile(path.join(repo, "src", "greeting.js"), 'export const greeting = "Hello, world!";\n');
    await runGit(repo, ["add", "--all"]);
    await runGit(repo, ["commit", "-m", "Add a friendly greeting\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"]);
    await writeFile(path.join(repo, "src", "greeting.js"), 'export const greeting = "Hello, explorers!";\n');
    const data = path.join(fixture, "isolated-data");
    const store = new RepositoryStore(data);
    await store.add(repo);
    const service = new GitService();
    servers.push(await startServer({ service, store, initialRepo: repo }));

    child = spawn(browser, [
        "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions",
        "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${path.join(fixture, "browser-profile")}`, "--window-size=1440,1000", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Chromium did not expose its isolated debugging endpoint")), 20000);
        let stderr = "";
        child.once("error", reject);
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chromium exited before startup: ${code}`)); });
        child.stderr.on("data", (data) => {
            stderr += data;
            const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    let nextId = 0;
    function send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    const { targetId } = await send("Target.createTarget", { url: servers[0].url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    async function waitFor(expression) {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await evaluate(expression)) return;
            await delay(100);
        }
        throw new Error(`Browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
    }
    const ready = 'document.getElementById("head-badge")?.textContent.includes("main") && !document.getElementById("status-text").textContent.includes("Loading")';
    await waitFor(ready);
    assert.equal(await evaluate('document.getElementById("error-banner").hidden'), true);
    await evaluate('document.querySelector("#change-trees .file-row button").click()');
    await waitFor('document.querySelector("#detail .diff-table") !== null');
    await evaluate('[...document.querySelectorAll("#detail button")].find(b => b.textContent === "Side by side").click()');
    await waitFor('[...document.querySelectorAll("#detail button")].some(b => b.textContent === "Side by side" && b.getAttribute("aria-pressed") === "true")');
    await waitFor('!document.getElementById("status-text").textContent.includes("Loading")');
    assert.equal((await store.getPreferences(repo)).diffMode, "split");
    if (process.argv[3]) {
        const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        await writeFile(path.resolve(process.argv[3]), Buffer.from(screenshot.data, "base64"));
    }
    await evaluate('document.getElementById("tab-history").click()');
    await waitFor('!document.getElementById("status-text").textContent.includes("Loading") && document.getElementById("tab-history").getAttribute("aria-pressed") === "true"');
    assert.equal((await store.getPreferences(repo)).tab, "history");

    servers.push(await startServer({ service, store: new RepositoryStore(data), initialRepo: repo }));
    assert.notEqual(new URL(servers[0].url).port, new URL(servers[1].url).port);
    await send("Page.navigate", { url: servers[1].url }, sessionId);
    await waitFor(ready);
    await waitFor('document.getElementById("tab-history").getAttribute("aria-pressed") === "true"');
    assert.equal(await evaluate('document.getElementById("error-banner").hidden'), true);
    assert.match(await evaluate('document.getElementById("detail").innerText'), /Add a friendly greeting/);
    await evaluate('document.getElementById("tab-changes").click(); document.querySelector("#change-trees .file-row button").click()');
    await waitFor('[...document.querySelectorAll("#detail button")].some(b => b.textContent === "Side by side" && b.getAttribute("aria-pressed") === "true")');
    assert.equal((await service.status(repo)).changes[0].index, ".", "browsing must not stage the fixture file");
    process.stdout.write("Browser smoke passed: real renderer, split diff, history and preferences across loopback origins; no host SDK session was exercised.\n");
} finally {
    socket?.close();
    for (const request of pending.values()) clearTimeout(request.timer);
    if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
    }
    for (const server of servers) await server.close();
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
