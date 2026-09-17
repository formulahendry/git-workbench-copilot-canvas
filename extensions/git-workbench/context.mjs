import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalRepo, GitError } from "./git.mjs";

export async function registerRepository(value, store) {
    const normalize = (name) => {
        const resolved = path.resolve(name);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const catalog = await store.catalog();
    const existing = catalog.repositories.find((repo) => normalize(repo.path) === normalize(value));
    if (existing) return existing.path;
    const root = await canonicalRepo(value);
    await store.add(root);
    return root;
}

async function sessionWorkingTree(workingDirectory) {
    if (!workingDirectory) return "";
    if (!path.isAbsolute(workingDirectory)) throw new GitError("invalid_session_directory", "Session working directory must be absolute.");
    let directory = await realpath(workingDirectory);
    while (true) {
        let hasGitMarker = false;
        // A linked worktree or submodule has a .git file, not a .git directory.
        try {
            await stat(path.join(directory, ".git"));
            hasGitMarker = true;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (hasGitMarker) return canonicalRepo(workingDirectory);
        const parent = path.dirname(directory);
        if (parent === directory) return "";
        directory = parent;
    }
}

export async function initialContext({ explicitRepo, workingDirectory }, store) {
    if (explicitRepo) {
        return { initialRepo: await registerRepository(explicitRepo, store), source: "explicit", workingDirectory: workingDirectory || "" };
    }
    const current = await sessionWorkingTree(workingDirectory);
    if (current) {
        return { initialRepo: await registerRepository(current, store), source: "session", workingDirectory };
    }
    const catalog = await store.catalog();
    const remembered = catalog.repositories.find((repo) => repo.path === catalog.lastSelectedRepo);
    return { initialRepo: remembered?.path || "", source: remembered ? "last-selected" : "none", workingDirectory: workingDirectory || "" };
}
