import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { GitService } from "./git.mjs";
import { initialContext, registerRepository } from "./context.mjs";
import { RepositoryStore } from "./store.mjs";
import { startServer } from "./server.mjs";

const service = new GitService();
const store = new RepositoryStore();
const servers = new Map();
const readSchema = {
    type: "object",
    properties: {
        repo: { type: "string", minLength: 1 },
        view: { enum: ["snapshot", "history", "commit", "diff", "blame", "files", "stash", "compare"] },
        args: { type: "object", additionalProperties: true },
    },
    required: ["repo", "view"],
    additionalProperties: false,
};
let session;

async function routed(callback) {
    try { return await callback(); }
    catch (error) { throw new CanvasError(error.code || "git_workbench_error", error.message); }
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "git-workbench",
            displayName: "Git Workbench",
            description: "Browse repository trees, diffs, history, branches, blame, stash and worktrees, with user-confirmed Git operations.",
            inputSchema: {
                type: "object",
                properties: {
                    repoPath: { type: "string", minLength: 1 },
                    repositories: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100 },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "catalog",
                    description: "List persisted repository roots. Does not change Git state.",
                    inputSchema: { type: "object", additionalProperties: false },
                    handler: () => routed(() => store.catalog()),
                },
                {
                    name: "context",
                    description: "Report the repository selected on open and whether it came from explicit input, the session worktree, or the last manual selection.",
                    inputSchema: { type: "object", additionalProperties: false },
                    handler: (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) throw new CanvasError("canvas_not_open", "Open Git Workbench first.");
                        return entry.context;
                    },
                },
                {
                    name: "read",
                    description: "Read Git state or history for a registered repository. Writes are only available through the user confirmation UI.",
                    inputSchema: readSchema,
                    handler: (ctx) => routed(async () => service.read(await store.resolve(ctx.input.repo), ctx.input.view, ctx.input.args)),
                },
            ],
            open: (ctx) => routed(async () => {
                for (const repo of ctx.input?.repositories || []) await registerRepository(repo, store);
                const context = await initialContext({
                    explicitRepo: ctx.input?.repoPath,
                    workingDirectory: ctx.session?.workingDirectory,
                }, store);
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer({
                        service, store,
                        initialRepo: context.initialRepo,
                        repositoryContext: context,
                        log: (message) => session?.log(message, { level: "warning", ephemeral: true }),
                    });
                    entry.context = context;
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Git Workbench", url: entry.url };
            }),
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await entry.close();
                }
            },
        }),
    ],
});
