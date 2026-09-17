import { mkdir, open, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalRepo, GitError } from "./git.mjs";
import { defaultPreferences, validatePreferences } from "./preferences.mjs";

export const artifactDirectory = path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "extensions", "git-workbench", "artifacts");

export class RepositoryStore {
    constructor(directory = artifactDirectory) {
        this.directory = directory;
        this.file = path.join(directory, "repositories.json");
        this.queue = Promise.resolve();
    }

    async catalog() {
        try {
            const catalog = JSON.parse(await readFile(this.file, "utf8"));
            if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.repositories) ||
                (catalog.lastSelectedRepo !== undefined && typeof catalog.lastSelectedRepo !== "string") ||
                catalog.repositories.some((repo) => !repo || typeof repo.path !== "string" || typeof repo.name !== "string")) {
                throw new GitError("catalog_invalid", `Invalid repository catalog: ${this.file}`);
            }
            for (const repo of catalog.repositories) {
                if (repo.preferences !== undefined) validatePreferences(repo.preferences);
            }
            return catalog;
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, repositories: [] };
            throw error;
        }
    }

    change(update) {
        const operation = this.queue.then(async () => {
            await mkdir(this.directory, { recursive: true });
            const lockPath = `${this.file}.lock`;
            let lock;
            for (let attempt = 0; attempt < 50; attempt++) {
                try { lock = await open(lockPath, "wx"); break; }
                catch (error) {
                    if (error.code !== "EEXIST") throw error;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            if (!lock) throw new GitError("catalog_locked", `The repository catalog is locked by another session. If no session is updating it, remove the stale lock: ${lockPath}`);
            let temporary;
            try {
                const catalog = await this.catalog();
                await update(catalog);
                temporary = `${this.file}.${randomUUID()}.tmp`;
                await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n", { flag: "wx" });
                await rename(temporary, this.file);
                temporary = undefined;
                return catalog;
            } finally {
                if (temporary) {
                    try { await unlink(temporary); }
                    catch (error) { if (error.code !== "ENOENT") throw error; }
                }
                await lock.close();
                await unlink(lockPath);
            }
        });
        // The caller still receives a rejection; only release the serialization queue here.
        this.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    async add(value) {
        const root = await canonicalRepo(value);
        return this.change((catalog) => {
            if (!catalog.repositories.some((repo) => equalPath(repo.path, root))) catalog.repositories.push({ path: root, name: path.basename(root) });
        });
    }

    async remove(value) {
        return this.change((catalog) => {
            catalog.repositories = catalog.repositories.filter((repo) => !equalPath(repo.path, value));
            if (catalog.lastSelectedRepo && equalPath(catalog.lastSelectedRepo, value)) delete catalog.lastSelectedRepo;
        });
    }

    async remember(value) {
        const root = await this.resolve(value);
        return this.change((catalog) => {
            if (!catalog.repositories.some((repo) => equalPath(repo.path, root))) throw new GitError("repository_not_registered", "Repository was removed from the catalog before selection.");
            catalog.lastSelectedRepo = root;
        });
    }

    async getPreferences(value) {
        const root = await this.resolve(value);
        const catalog = await this.catalog();
        const entry = catalog.repositories.find((repo) => equalPath(repo.path, root));
        if (!entry) throw new GitError("repository_not_registered", "Repository was removed before loading preferences.");
        return { ...defaultPreferences(), ...validatePreferences(entry.preferences || {}) };
    }

    async setPreferences(value, preferences) {
        const patch = validatePreferences(preferences);
        const root = await this.resolve(value);
        const catalog = await this.change((catalog) => {
            const entry = catalog.repositories.find((repo) => equalPath(repo.path, root));
            if (!entry) throw new GitError("repository_not_registered", "Repository was removed before saving preferences.");
            entry.preferences = { ...validatePreferences(entry.preferences || {}), ...patch };
        });
        const entry = catalog.repositories.find((repo) => equalPath(repo.path, root));
        return { ...defaultPreferences(), ...entry.preferences };
    }

    async resolve(value) {
        if (typeof value !== "string") throw new GitError("repository_required", "Choose a repository first.");
        const catalog = await this.catalog();
        const entry = catalog.repositories.find((repo) => equalPath(repo.path, value));
        if (!entry) throw new GitError("repository_not_registered", "Add this repository to Git Workbench before reading or operating on it.");
        const root = await canonicalRepo(entry.path);
        if (!equalPath(root, entry.path)) throw new GitError("repository_moved", "Repository identity changed. Remove and re-add its current path.");
        return root;
    }
}

function equalPath(a, b) {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
