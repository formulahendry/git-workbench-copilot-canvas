import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GitError } from "./git.mjs";

const assets = new Map([
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/preferences.mjs", ["preferences.mjs", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
}

function matchesToken(value, token) {
    return typeof value === "string" && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

async function body(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new GitError("request_too_large", "Request exceeds 1 MB.");
        chunks.push(chunk);
    }
    try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new SyntaxError("Expected a JSON object.");
        return result;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new GitError("invalid_json", error.message);
    }
}

function displayCommand(command) {
    return "git " + command.map((arg) => /^[a-zA-Z0-9_./:@{}=-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ");
}

export async function startServer({ service, store, initialRepo = "", repositoryContext, log = () => {} }) {
    const token = randomBytes(32).toString("hex");
    const confirmations = new Map();
    let origin;
    let busy = false;
    const server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
        handle(request, response).catch((error) => {
            log(`Git Workbench: ${error.message}`);
            if (response.headersSent) { response.destroy(); return; }
            json(response, error.code === "unauthorized" ? 403 : 400, { error: { code: error.code || "internal_error", message: error.message } });
        });
    });

    async function handle(request, response) {
        if (request.headers.host !== new URL(origin).host) throw new GitError("unauthorized", "Invalid loopback host.");
        const url = new URL(request.url, origin);
        if (request.method === "GET" && url.pathname === "/") {
            if (!matchesToken(url.searchParams.get("token"), token)) throw new GitError("unauthorized", "Open this canvas through Copilot.");
            const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
            const bootstrap = JSON.stringify({ token, initialRepo, repositoryContext }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(html.replace("__BOOTSTRAP__", () => bootstrap));
            return;
        }
        if (request.method === "GET" && assets.has(url.pathname)) {
            const [file, type] = assets.get(url.pathname);
            response.writeHead(200, { "Content-Type": type });
            response.end(await readFile(new URL(file, import.meta.url)));
            return;
        }
        if (request.method !== "POST" || url.pathname !== "/api") { json(response, 404, { error: { code: "not_found", message: "Not found." } }); return; }
        if (!matchesToken(request.headers["x-git-workbench-token"], token) ||
            (request.headers.origin && request.headers.origin !== origin)) {
            throw new GitError("unauthorized", "Invalid canvas token or request origin.");
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) throw new GitError("invalid_content_type", "Expected application/json.");
        const input = await body(request);
        let result;
        switch (input.action) {
            case "catalog": result = await store.catalog(); break;
            case "add_repository": result = await store.add(input.path); break;
            case "select_repository": result = await store.remember(input.repo); break;
            case "get_preferences": result = await store.getPreferences(input.repo); break;
            case "set_preferences": result = await store.setPreferences(input.repo, input.preferences); break;
            case "remove_repository":
                if (typeof input.repo !== "string") throw new GitError("invalid_input", "Repository path is required.");
                result = await store.remove(input.repo); break;
            case "read": result = await service.read(await store.resolve(input.repo), input.view, input.args); break;
            case "prepare": {
                if (busy) throw new GitError("operation_busy", "Another operation is running.");
                for (const [id, plan] of confirmations) if (plan.expires < Date.now()) confirmations.delete(id);
                if (confirmations.size >= 20) throw new GitError("too_many_previews", "Too many confirmation previews. Wait two minutes and try again.");
                const repo = await store.resolve(input.repo);
                const plan = await service.prepare(repo, input.operation, input.params);
                const confirmationId = randomBytes(24).toString("hex");
                const expires = Date.now() + 120000;
                confirmations.set(confirmationId, { ...plan, expires });
                result = {
                    confirmationId, title: plan.title, summary: plan.summary,
                    commands: plan.commands.map(displayCommand), warning: plan.warning, expiresAt: new Date(expires).toISOString(),
                };
                break;
            }
            case "execute": {
                if (busy) throw new GitError("operation_busy", "Another operation is running.");
                const plan = confirmations.get(input.confirmationId);
                confirmations.delete(input.confirmationId);
                if (!plan || plan.expires < Date.now()) throw new GitError("confirmation_expired", "Confirmation expired or was already used. Preview and confirm again.");
                await store.resolve(plan.repo);
                busy = true;
                try {
                    const execution = await service.execute(plan);
                    let snapshot;
                    try { snapshot = await service.snapshot(plan.repo); }
                    catch (error) { throw new GitError("refresh_failed_after_write", `Git completed: ${execution.output}\nThe follow-up refresh failed: ${error.message}\nDo not repeat the operation blindly; refresh the repository.`); }
                    result = { ...execution, snapshot };
                } finally { busy = false; }
                break;
            }
            default: throw new GitError("invalid_action", "Unknown API action.");
        }
        json(response, 200, result);
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    return {
        url: `${origin}/?token=${token}`,
        async close() {
            confirmations.clear();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
                server.closeIdleConnections();
            });
        },
    };
}
