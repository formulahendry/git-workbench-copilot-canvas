import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class GitError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function requireValue(condition, message) {
    if (!condition) throw new GitError("invalid_input", message);
}

function text(value, name, max = 4096) {
    requireValue(typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0"), `Invalid ${name}.`);
    return value;
}

function refText(value) {
    text(value, "reference", 1024);
    requireValue(!value.startsWith("-") && !value.includes("\n"), "Invalid Git reference.");
    return value;
}

function filePath(value) {
    text(value, "relative file path");
    requireValue(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
        !value.includes("\\") && !value.split("/").some((part) => part === ".." || part.toLowerCase() === ".git"),
    "File paths must be repository-relative, use '/', and may not traverse .git or parent directories.");
    return value;
}

function boundedInt(value, fallback, max) {
    if (value === undefined) return fallback;
    requireValue(Number.isInteger(value) && value >= 0 && value <= max, `Expected an integer from 0 to ${max}.`);
    return value;
}

// No shell, pagers, external diff drivers, textconv, or interactive credentials.
export function runGit(repo, args, { codes = [0], timeout = 25000, maxBytes = 12 * 1024 * 1024, input } = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES)$/i.test(key)) delete env[key];
        }
        Object.assign(env, {
            GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
            GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1",
        });
        const child = spawn("git", ["--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false", ...args], {
            cwd: repo, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [], stderr = [];
        let size = 0, failure;
        const timer = setTimeout(() => {
            failure = new GitError("git_timeout", "Git timed out. The operation may already have changed the repository; refresh before retrying.");
            child.kill();
        }, timeout);
        const collect = (chunks) => (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                failure = new GitError("output_limit", "Git output exceeds 12 MB. Narrow the file, revision, or comparison.");
                child.kill();
            } else chunks.push(chunk);
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        child.on("error", (error) => { clearTimeout(timer); reject(new GitError("git_unavailable", error.message)); });
        child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE") failure = new GitError("git_stdin", error.message);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            const result = { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
            if (!codes.includes(code)) return reject(new GitError("git_failed", result.stderr.trim() || `Git exited with code ${code}.`));
            resolve(result);
        });
        child.stdin.end(input);
    });
}

export async function canonicalRepo(value) {
    text(value, "repository path");
    requireValue(path.isAbsolute(value), "Repository path must be absolute.");
    const resolved = await realpath(value);
    const result = await runGit(resolved, ["rev-parse", "--show-toplevel"]);
    return realpath(result.stdout.trim());
}

function fields(record, count) {
    const result = [];
    let start = 0;
    for (let index = 0; index < count; index++) {
        const end = record.indexOf(" ", start);
        requireValue(end >= 0, "Unexpected Git status format.");
        result.push(record.slice(start, end));
        start = end + 1;
    }
    result.push(record.slice(start));
    return result;
}

export function parseStatus(raw) {
    const result = { branch: "", head: "", upstream: "", ahead: 0, behind: 0, changes: [] };
    const records = raw.split("\0");
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (record.startsWith("# branch.oid ")) result.head = record.slice(13);
        else if (record.startsWith("# branch.head ")) result.branch = record.slice(14);
        else if (record.startsWith("# branch.upstream ")) result.upstream = record.slice(18);
        else if (record.startsWith("# branch.ab ")) {
            const match = record.match(/\+(\d+) -(\d+)/);
            if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
        } else if (record.startsWith("? ")) {
            result.changes.push({ path: record.slice(2), index: "?", worktree: "?", untracked: true, conflict: false });
        } else if (/^[12u] /.test(record)) {
            const type = record[0];
            const parts = fields(record, type === "1" ? 8 : type === "2" ? 9 : 10);
            const change = { path: parts.at(-1), index: parts[1][0], worktree: parts[1][1], untracked: false, conflict: type === "u" };
            if (type === "2") change.originalPath = records[++i];
            result.changes.push(change);
        }
    }
    return result;
}

function parseNames(raw) {
    const entries = raw.split("\0");
    const result = [];
    for (let i = 0; i < entries.length && entries[i];) {
        const status = entries[i++];
        if (/^[RC]/.test(status)) result.push({ status, originalPath: entries[i++], path: entries[i++] });
        else result.push({ status, path: entries[i++] });
    }
    return result;
}

function parseCommits(raw) {
    const tokens = raw.split("\0");
    const commits = [];
    // Fields are NUL-delimited: user-controlled subjects can contain tabs and record separators.
    for (let i = 0; i + 7 < tokens.length; i += 9) {
        const oid = tokens[i].trim();
        if (!/^[a-f0-9]{40,64}$/.test(oid)) continue;
        commits.push({
            oid, shortOid: tokens[i + 1], parents: tokens[i + 2].split(" ").filter(Boolean),
            author: tokens[i + 3], email: tokens[i + 4], date: tokens[i + 5], subject: tokens[i + 6], refs: tokens[i + 7],
        });
    }
    return commits;
}

const historyFormat = "%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%D%x00";
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
const locks = new Set();

export class GitService {
    async status(repo) {
        return parseStatus((await runGit(repo, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"])).stdout);
    }

    async resolve(repo, ref) {
        refText(ref);
        return (await runGit(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
    }

    async snapshot(repo) {
        const status = await this.status(repo);
        const refsRaw = (await runGit(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(subject)%00%(creatordate:iso-strict)", "refs/heads", "refs/remotes", "refs/tags"])).stdout;
        const branches = [], tags = [];
        for (const line of refsRaw.trimEnd().split("\n").filter(Boolean)) {
            const [ref, oid, current, upstream, track, subject, date] = line.split("\0");
            if (ref.startsWith("refs/tags/")) tags.push({ name: ref.slice(10), oid, subject, date });
            else branches.push({ name: ref.replace(/^refs\/(?:heads|remotes)\//, ""), ref, oid, current: current === "*", upstream, track });
        }
        const remoteNames = (await runGit(repo, ["remote"])).stdout.trim().split("\n").filter(Boolean);
        const remotes = [];
        for (const name of remoteNames) {
            remotes.push({
                name,
                fetchUrl: (await runGit(repo, ["remote", "get-url", "--", name])).stdout.trim(),
                pushUrl: (await runGit(repo, ["remote", "get-url", "--push", "--", name])).stdout.trim(),
            });
        }
        const stashRaw = (await runGit(repo, ["stash", "list", "-z", "--format=%gd%x00%H%x00%gs%x00%cI"])).stdout.split("\0");
        const stashes = [];
        for (let i = 0; i + 3 < stashRaw.length; i += 4) stashes.push({ ref: stashRaw[i], oid: stashRaw[i + 1], subject: stashRaw[i + 2], date: stashRaw[i + 3] });
        const worktreeRaw = (await runGit(repo, ["worktree", "list", "--porcelain", "-z"])).stdout.split("\0");
        const worktrees = [];
        let worktree;
        for (const line of worktreeRaw) {
            if (line.startsWith("worktree ")) {
                worktree = { path: line.slice(9), head: "", branch: "", bare: false, locked: false, prunable: false };
                worktrees.push(worktree);
            } else if (worktree && line.startsWith("HEAD ")) worktree.head = line.slice(5);
            else if (worktree && line.startsWith("branch ")) worktree.branch = line.slice(7).replace(/^refs\/heads\//, "");
            else if (worktree && /^(bare|locked|prunable)( |$)/.test(line)) worktree[line.split(" ")[0]] = true;
        }
        const gitDir = (await runGit(repo, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
        const inProgress = [];
        for (const [name, label] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase/am"], ["BISECT_LOG", "bisect"]]) {
            try { await stat(path.join(gitDir, name)); inProgress.push(label); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return { repo, name: path.basename(repo), ...status, branches, tags, remotes, stashes, worktrees, inProgress };
    }

    async history(repo, args) {
        const ref = args.ref ?? "HEAD";
        const limit = boundedInt(args.limit, 80, 200);
        requireValue(limit > 0, "History limit must be positive.");
        const skip = boundedInt(args.skip, 0, 100000);
        const status = await this.status(repo);
        if (status.head === "(initial)" && ref === "HEAD") return { commits: [], hasMore: false };
        const resolved = ref === "--all" ? "--all" : await this.resolve(repo, ref);
        const command = ["log", "-z", `--format=${historyFormat}`, "--date-order", `--max-count=${limit + 1}`, `--skip=${skip}`];
        if (args.path) command.push("--follow");
        if (args.search) command.push("--fixed-strings", "--regexp-ignore-case", `--grep=${text(args.search, "search", 500)}`);
        command.push(resolved, "--");
        if (args.path) command.push(filePath(args.path));
        const commits = parseCommits((await runGit(repo, command)).stdout);
        return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
    }

    async diff(repo, args) {
        const file = filePath(args.path);
        requireValue(["staged", "working"].includes(args.side), "Diff side must be staged or working.");
        const status = await this.status(repo);
        const entry = status.changes.find((item) => item.path === file);
        if (entry?.untracked && args.side === "working") {
            const absolute = await this.safeFile(repo, file);
            const info = await lstat(absolute);
            requireValue(!info.isDirectory(), "Nested repositories cannot be previewed as text files.");
            requireValue(info.size <= 1024 * 1024, "Untracked preview exceeds 1 MB.");
            const data = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
            if (data.includes(0)) return { path: file, side: args.side, diff: `Binary file: ${file}`, binary: true };
            const lines = data.toString("utf8").split("\n");
            if (lines.at(-1) === "") lines.pop();
            return { path: file, side: args.side, diff: `diff --git a/${file} b/${file}\nnew file mode ${info.isSymbolicLink() ? "120000" : "100644"}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n` };
        }
        const command = ["diff", ...diffOptions];
        if (args.side === "staged") command.push("--cached");
        command.push("--", file);
        if (entry?.originalPath) command.push(entry.originalPath);
        return { path: file, side: args.side, diff: (await runGit(repo, command)).stdout };
    }

    async safeFile(repo, file) {
        // Compare real paths on both sides, including Windows short-name or junction aliases.
        const root = await realpath(repo);
        const absolute = path.resolve(root, filePath(file));
        const parent = await realpath(path.dirname(absolute));
        const relative = path.relative(root, parent);
        requireValue(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "File resolves outside the repository.");
        return absolute;
    }

    async commit(repo, args) {
        const oid = await this.resolve(repo, args.ref);
        const raw = (await runGit(repo, ["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b", oid, "--"])).stdout;
        const [hash, parents, author, email, date, subject, ...body] = raw.split("\0");
        const files = parseNames((await runGit(repo, ["diff-tree", "--root", "--no-commit-id", "-r", "--first-parent", "-m", "--name-status", "-z", "--find-renames", oid, "--"])).stdout);
        const diff = (await runGit(repo, ["show", "--format=", "--first-parent", ...diffOptions, oid, "--"])).stdout;
        return { oid: hash, parents: parents.split(" ").filter(Boolean), author, email, date, subject, body: body.join("\0").trimEnd(), files, diff };
    }

    async blame(repo, args) {
        const file = filePath(args.path);
        const command = ["blame", "--line-porcelain"];
        if (args.ref) command.push(await this.resolve(repo, args.ref));
        command.push("--", file);
        const result = await runGit(repo, command);
        const lines = [];
        let current;
        for (const line of result.stdout.split("\n")) {
            const header = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/);
            if (header) current = { oid: header[1], originalLine: Number(header[2]), line: Number(header[3]), author: "", date: "", summary: "" };
            else if (current && line.startsWith("author ")) current.author = line.slice(7);
            else if (current && line.startsWith("author-time ")) current.date = new Date(Number(line.slice(12)) * 1000).toISOString();
            else if (current && line.startsWith("summary ")) current.summary = line.slice(8);
            else if (current && line.startsWith("\t")) { lines.push({ ...current, text: line.slice(1) }); current = undefined; }
        }
        return { path: file, lines: lines.slice(0, 2000), truncated: lines.length > 2000 };
    }

    async files(repo, args) {
        const limit = boundedInt(args.limit, 1000, 2000);
        const search = args.search ? text(args.search, "file search", 500).toLowerCase() : "";
        const all = (await runGit(repo, ["ls-files", "-z"])).stdout.split("\0").filter((file) => file && file.toLowerCase().includes(search));
        const unique = [...new Set(all)];
        return { files: unique.slice(0, limit), truncated: unique.length > limit };
    }

    async stash(repo, args) {
        requireValue(/^stash@\{\d+\}$/.test(args.ref), "Choose an existing stash reference.");
        await this.resolve(repo, args.ref);
        return { ref: args.ref, diff: (await runGit(repo, ["stash", "show", "--patch", "--include-untracked", ...diffOptions, args.ref, "--"])).stdout };
    }

    async compare(repo, args) {
        const base = await this.resolve(repo, args.base), target = await this.resolve(repo, args.target);
        const files = parseNames((await runGit(repo, ["diff", "--name-status", "-z", "--find-renames", base, target, "--"])).stdout);
        return { base: args.base, target: args.target, files, diff: (await runGit(repo, ["diff", ...diffOptions, base, target, "--"])).stdout };
    }

    async read(repo, view, args = {}) {
        requireValue(args && typeof args === "object" && !Array.isArray(args), "Read arguments must be an object.");
        requireValue(["snapshot", "history", "commit", "diff", "blame", "files", "stash", "compare"].includes(view), "Unknown read view.");
        return this[view](repo, args);
    }

    async fingerprint(repo, status) {
        const hash = createHash("sha256");
        hash.update(JSON.stringify(status ?? await this.status(repo)));
        for (const args of [["show-ref", "--head"], ["ls-files", "--stage", "-z"], ["diff", "--binary", ...diffOptions], ["diff", "--cached", "--binary", ...diffOptions]]) {
            hash.update((await runGit(repo, args, { codes: args[0] === "show-ref" ? [0, 1] : [0] })).stdout);
        }
        for (const change of (status ?? await this.status(repo)).changes.filter((item) => item.untracked)) {
            const absolute = await this.safeFile(repo, change.path);
            const info = await lstat(absolute);
            requireValue(!info.isDirectory(), `Untracked nested repository cannot be safely included in a confirmation: ${change.path}. Add or ignore it explicitly with Git first.`);
            requireValue(info.size <= 12 * 1024 * 1024, `Cannot safely confirm untracked files larger than 12 MB: ${change.path}`);
            hash.update(change.path);
            hash.update(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
        }
        return hash.digest("hex");
    }

    async prepare(repo, operation, params = {}) {
        requireValue(params && typeof params === "object" && !Array.isArray(params), "Operation parameters must be an object.");
        const snapshot = await this.snapshot(repo);
        const commands = [];
        let title, summary;
        const warning = "This runs local Git, including configured Git hooks and credential helpers. It cannot automatically undo completed steps. No force push, hard reset, or automatic conflict resolution.";
        const paths = () => {
            requireValue(Array.isArray(params.paths) && params.paths.length <= 5000, "Expected at most 5000 file paths.");
            const selected = params.paths.map(filePath);
            for (const file of selected) requireValue(snapshot.changes.some((item) => item.path === file || item.originalPath === file), `File is no longer changed: ${file}`);
            return [...new Set(selected)];
        };
        switch (operation) {
            case "stage": {
                const selected = paths();
                title = "Stage changes";
                summary = selected.length ? `Stage ${selected.length} selected path(s).` : "Stage ALL changes, including untracked files and deletions.";
                const expanded = [...new Set(selected.flatMap((file) => {
                    const item = snapshot.changes.find((change) => change.path === file);
                    return item?.originalPath ? [file, item.originalPath] : [file];
                }))];
                commands.push(["add", "--all", "--", ...(expanded.length ? expanded : ["."])]);
                break;
            }
            case "unstage": {
                const selected = paths();
                title = "Unstage changes";
                summary = "Remove selected changes from the index; working files are preserved.";
                const expanded = [...new Set(selected.flatMap((file) => {
                    const item = snapshot.changes.find((change) => change.path === file);
                    return item?.originalPath ? [file, item.originalPath] : [file];
                }))];
                if (snapshot.head === "(initial)") commands.push(["rm", "--cached", "-r", "--", ...(expanded.length ? expanded : ["."])]);
                else commands.push(["restore", "--staged", "--", ...(expanded.length ? expanded : ["."])]);
                break;
            }
            case "commit":
                requireValue(!snapshot.inProgress.length && !snapshot.changes.some((item) => item.conflict), "Resolve the in-progress Git operation/conflicts before committing here.");
                requireValue(snapshot.changes.some((item) => !item.untracked && item.index !== "."), "There are no staged changes to commit.");
                text(params.message, "commit message", 20000);
                requireValue(params.message.trim().length > 0, "Commit message cannot be blank.");
                title = "Confirm commit";
                summary = `Commit ALL staged changes only. Unstaged and untracked content is not included.\n\n${params.message}`;
                commands.push(["commit", "--file=-"]);
                break;
            case "switch_branch":
                refText(params.branch);
                requireValue(snapshot.branches.some((item) => item.ref === `refs/heads/${params.branch}`), "Select an existing local branch.");
                requireValue(snapshot.changes.length === 0 && !snapshot.inProgress.length, "Branch switching requires a clean working tree. Commit or stash first.");
                title = "Switch branch"; summary = `Check out local branch ${params.branch}.`;
                commands.push(["switch", "--", params.branch]);
                break;
            case "create_branch": {
                refText(params.name);
                await runGit(repo, ["check-ref-format", "--branch", params.name]);
                requireValue(!params.name.startsWith("@{-"), "Previous-checkout syntax is not a new branch name.");
                requireValue(snapshot.changes.length === 0 && !snapshot.inProgress.length, "Creating and switching a branch requires a clean working tree.");
                const start = await this.resolve(repo, params.startPoint || "HEAD");
                title = "Create and switch branch"; summary = `Create ${params.name} at ${start.slice(0, 12)} and switch to it.`;
                commands.push(["switch", "-c", params.name, start]);
                break;
            }
            case "fetch":
                requireValue(snapshot.remotes.some((item) => item.name === params.remote), "Select a configured remote.");
                refText(params.remote);
                title = "Fetch remote"; summary = `Download objects and update remote-tracking refs from ${params.remote}; do not merge or prune.`;
                commands.push(["fetch", "--", params.remote]);
                break;
            case "pull":
                requireValue(snapshot.upstream && snapshot.branch !== "(detached)", "Pull requires an upstream on a local branch.");
                requireValue(snapshot.changes.length === 0 && !snapshot.inProgress.length, "Pull requires a clean working tree and no in-progress operation.");
                title = "Pull (fast-forward only)"; summary = `Fetch and fast-forward ${snapshot.branch} from ${snapshot.upstream}. Diverged histories are refused.`;
                commands.push(["pull", "--ff-only", "--no-rebase"]);
                break;
            case "push": {
                requireValue(snapshot.upstream && snapshot.branch !== "(detached)", "Push requires an existing upstream on a local branch. Configure it outside this canvas first.");
                const remote = (await runGit(repo, ["config", "--get", `branch.${snapshot.branch}.remote`])).stdout.trim();
                const mergeRef = (await runGit(repo, ["config", "--get", `branch.${snapshot.branch}.merge`])).stdout.trim();
                requireValue(snapshot.remotes.some((item) => item.name === remote), "Upstream must use a configured named remote.");
                requireValue(mergeRef.startsWith("refs/heads/") && !mergeRef.includes("\n"), "Upstream must target one branch.");
                title = "Push branch"; summary = `Publish ${snapshot.branch} to ${remote}/${mergeRef.slice(11)} without force.`;
                commands.push(["-c", "remote." + remote + ".mirror=false", "-c", "push.followTags=false", "push", "--no-force", "--no-follow-tags", "--", remote, `HEAD:${mergeRef}`]);
                break;
            }
            case "stash_push":
                requireValue(!snapshot.inProgress.length && !snapshot.changes.some((item) => item.conflict), "Cannot stash during an in-progress operation or conflict.");
                requireValue(snapshot.changes.some((item) => !item.untracked || params.includeUntracked === true), "No eligible changes to stash.");
                if (params.includeUntracked !== undefined) requireValue(typeof params.includeUntracked === "boolean", "includeUntracked must be boolean.");
                title = "Stash changes"; summary = `Save tracked changes${params.includeUntracked ? " and untracked files" : ""} and remove them from the working tree.`;
                commands.push(["stash", "push", ...(params.includeUntracked ? ["--include-untracked"] : []), "--message", params.message ? text(params.message, "stash message", 1000) : "Git Workbench stash"]);
                break;
            case "stash_apply":
            case "stash_pop":
                requireValue(/^stash@\{\d+\}$/.test(params.ref) && snapshot.stashes.some((item) => item.ref === params.ref), "Select an existing stash.");
                requireValue(snapshot.changes.length === 0 && !snapshot.inProgress.length, "Stash apply/pop requires a clean working tree.");
                title = operation === "stash_pop" ? "Pop stash" : "Apply stash";
                summary = `Restore ${params.ref}. ${operation === "stash_pop" ? "Remove the stash only if Git applies it successfully." : "Keep the saved stash."} Conflicts may require manual resolution.`;
                commands.push(["stash", operation === "stash_pop" ? "pop" : "apply", params.ref]);
                break;
            default: throw new GitError("invalid_operation", "Unsupported Git operation.");
        }
        return { repo, operation, params, title, summary, warning, commands, fingerprint: await this.fingerprint(repo, snapshot) };
    }

    async execute(plan) {
        const key = process.platform === "win32" ? plan.repo.toLowerCase() : plan.repo;
        requireValue(!locks.has(key), "Another Git operation is running for this repository.");
        locks.add(key);
        try {
            const current = await this.prepare(plan.repo, plan.operation, plan.params);
            requireValue(current.fingerprint === plan.fingerprint && JSON.stringify(current.commands) === JSON.stringify(plan.commands), "Repository changed since the preview. Refresh and confirm a new operation.");
            const output = [];
            for (const command of plan.commands) {
                const result = await runGit(plan.repo, command, { timeout: 120000, input: plan.operation === "commit" ? plan.params.message : undefined });
                output.push(result.stdout, result.stderr);
            }
            // Do not imply failure of the completed command if the follow-up refresh fails.
            return { output: output.join("").trim() || "Git operation completed." };
        } finally { locks.delete(key); }
    }
}
