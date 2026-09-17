import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitService, parseStatus, runGit } from "./git.mjs";
import { RepositoryStore } from "./store.mjs";
import { startServer } from "./server.mjs";
import { initialContext } from "./context.mjs";

const service = new GitService();
const trailer = "\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>";

test("UI assets use English labels, accessibility text and display formats", async (t) => {
    const server = await startServer({ service, store: new RepositoryStore() });
    t.after(() => server.close());
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /aria-label="Repository navigation"/);
    assert.match(html, />Review commit<\/button>/);
    assert.doesNotMatch(html, /\p{Script=Han}|\bzh-(?:CN|TW|Hans|Hant)\b/u);
    const response = await fetch(new URL("app.js", server.url));
    assert.equal(response.status, 200);
    const script = await response.text();
    assert.doesNotMatch(script, /\p{Script=Han}|\bzh-(?:CN|TW|Hans|Hant)\b/u);
    assert.match(script, /toLocaleString\("en-US"/);
    assert.match(script, /toLocaleTimeString\("en-US"/);
    assert.match(script, /submitLabel: "Confirm and run"/);
    assert.match(script, /submitLabel: "Refresh status only"/);
    for (const file of ["git.mjs", "server.mjs", "store.mjs", "context.mjs", "extension.mjs"]) {
        assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), /\p{Script=Han}/u, `${file} should keep its user-facing messages in English.`);
    }
});

async function fixture(t, populated = true) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-workbench-test-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo with spaces");
    await mkdir(repo);
    await runGit(repo, ["init", "--initial-branch=main"]);
    for (const [key, value] of [
        ["user.name", "Fixture Author"], ["user.email", "fixture@example.invalid"],
        ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.autocrlf", "false"],
        ["core.hooksPath", path.join(root, "no-hooks")],
    ]) await runGit(repo, ["config", key, value]);
    if (populated) {
        await mkdir(path.join(repo, "src"));
        await writeFile(path.join(repo, "src", "sample.txt"), "first line\nsecond line\n");
        await runGit(repo, ["add", "--all"]);
        await runGit(repo, ["commit", "-m", "Initial sample" + trailer]);
    }
    return { root, repo };
}

test("porcelain parser preserves spaces, rename sources, conflicts and branch tracking", () => {
    const data = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0" +
        "1 .M N... 100644 100644 100644 a b dir/file name.txt\0" +
        "2 R. N... 100644 100644 100644 a b R100 renamed name.txt\0old name.txt\0" +
        "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0? new file.txt\0";
    const result = parseStatus(data);
    assert.equal(result.branch, "main");
    assert.equal(result.upstream, "origin/main");
    assert.equal(result.ahead, 2);
    assert.equal(result.behind, 3);
    assert.equal(result.changes[0].path, "dir/file name.txt");
    assert.equal(result.changes[1].originalPath, "old name.txt");
    assert.equal(result.changes[2].path, "conflict.txt");
    assert.equal(result.changes[2].conflict, true);
    assert.equal(result.changes[3].untracked, true);
});

test("read views: history, commit, files, diff, blame, branches, tags and comparison", async (t) => {
    const { repo } = await fixture(t);
    await runGit(repo, ["tag", "v0.1"]);
    await runGit(repo, ["branch", "topic"]);
    await writeFile(path.join(repo, "src", "sample.txt"), "first line\nchanged line\n");
    await writeFile(path.join(repo, "new file.txt"), "new content\n");
    const snapshot = await service.snapshot(repo);
    assert.equal(snapshot.branch, "main");
    assert.equal(snapshot.changes.length, 2);
    assert.ok(snapshot.branches.find((branch) => branch.name === "topic"));
    assert.equal(snapshot.tags[0].name, "v0.1");
    assert.equal(snapshot.worktrees.length, 1);
    assert.equal((await service.history(repo, {})).commits[0].subject, "Initial sample");
    assert.equal((await service.history(repo, { search: "initial" })).commits.length, 1);
    assert.equal((await service.history(repo, { search: "does not exist" })).commits.length, 0);
    assert.match((await service.diff(repo, { path: "src/sample.txt", side: "working" })).diff, /\+changed line/);
    assert.match((await service.diff(repo, { path: "new file.txt", side: "working" })).diff, /\+new content/);
    assert.equal((await service.blame(repo, { path: "src/sample.txt", ref: "HEAD" })).lines.length, 2);
    assert.deepEqual((await service.files(repo, {})).files, ["src/sample.txt"]);
    const commit = await service.commit(repo, { ref: "HEAD" });
    assert.equal(commit.files[0].path, "src/sample.txt");
    assert.match(commit.diff, /\+first line/);
    assert.equal((await service.compare(repo, { base: "main", target: "topic" })).diff, "");
    await assert.rejects(service.diff(repo, { path: "../outside", side: "working" }), /repository-relative/);
    await assert.rejects(service.commit(repo, { ref: "--output=bad" }), /Invalid Git reference/);
});

test("stage, unstage, stale confirmation, commit, rename history and paging", async (t) => {
    const { repo } = await fixture(t);
    const sample = path.join(repo, "src", "sample.txt");
    await writeFile(sample, "first line\nstage me\n");
    const stale = await service.prepare(repo, "stage", { paths: ["src/sample.txt"] });
    await writeFile(sample, "first line\nchanged after preview\n");
    await assert.rejects(service.execute(stale), /changed since the preview/);
    await service.execute(await service.prepare(repo, "stage", { paths: ["src/sample.txt"] }));
    assert.match((await service.diff(repo, { path: "src/sample.txt", side: "staged" })).diff, /\+changed after preview/);
    await service.execute(await service.prepare(repo, "unstage", { paths: [] }));
    assert.equal((await service.status(repo)).changes[0].index, ".");
    await service.execute(await service.prepare(repo, "stage", { paths: [] }));
    await service.execute(await service.prepare(repo, "commit", { message: "Second sample" + trailer }));
    assert.equal((await service.status(repo)).changes.length, 0);
    await rename(sample, path.join(repo, "src", "renamed file.txt"));
    await service.execute(await service.prepare(repo, "stage", { paths: [] }));
    const renamed = await service.status(repo);
    assert.equal(renamed.changes[0].originalPath, "src/sample.txt");
    await service.execute(await service.prepare(repo, "unstage", { paths: ["src/renamed file.txt"] }));
    await service.execute(await service.prepare(repo, "stage", { paths: [] }));
    await service.execute(await service.prepare(repo, "commit", { message: "Rename sample" + trailer }));
    assert.equal((await service.history(repo, { path: "src/renamed file.txt" })).commits.length, 3);
    const page = await service.history(repo, { limit: 1 });
    assert.equal(page.commits.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal((await service.history(repo, { limit: 1, skip: 1 })).commits[0].subject, "Second sample");
    const commit = await service.commit(repo, { ref: "HEAD" });
    assert.equal(commit.files[0].originalPath, "src/sample.txt");
});

test("empty repository, literal option-like filenames and binary preview", async (t) => {
    const { repo } = await fixture(t, false);
    assert.deepEqual((await service.history(repo, {})).commits, []);
    await writeFile(path.join(repo, "--odd name.txt"), "literal file\n");
    await service.execute(await service.prepare(repo, "stage", { paths: ["--odd name.txt"] }));
    await service.execute(await service.prepare(repo, "unstage", { paths: [] }));
    assert.equal(await readFile(path.join(repo, "--odd name.txt"), "utf8"), "literal file\n");
    await writeFile(path.join(repo, "binary.bin"), Buffer.from([1, 0, 2]));
    assert.equal((await service.diff(repo, { path: "binary.bin", side: "working" })).binary, true);
});

test("file containment canonicalizes repository aliases without allowing outside directory links", async (t) => {
    const { repo, root } = await fixture(t, false);
    const alias = path.join(root, "repository-alias");
    const outside = `${repo}-outside`;
    await mkdir(outside);
    await writeFile(path.join(repo, "demo.txt"), "inside the repository\n");
    await writeFile(path.join(outside, "demo.txt"), "outside the repository\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(repo, alias, linkType);
    await symlink(outside, path.join(repo, "outside-link"), linkType);
    assert.equal(await service.safeFile(alias, "demo.txt"), path.join(repo, "demo.txt"));
    assert.match((await service.diff(alias, { path: "demo.txt", side: "working" })).diff, /inside the repository/);
    await assert.rejects(service.safeFile(alias, "outside-link/demo.txt"), /outside the repository/);
    await assert.rejects(service.safeFile(alias, "../demo.txt"), /repository-relative/);
});

test("branch creation/switching, stash apply/pop and linked worktree", async (t) => {
    const { repo, root } = await fixture(t);
    await service.execute(await service.prepare(repo, "create_branch", { name: "feature/demo" }));
    assert.equal((await service.status(repo)).branch, "feature/demo");
    await service.execute(await service.prepare(repo, "switch_branch", { branch: "main" }));
    await writeFile(path.join(repo, "src", "sample.txt"), "stash this\n");
    await service.execute(await service.prepare(repo, "stash_push", { message: "sample stash" }));
    const snapshot = await service.snapshot(repo);
    assert.equal(snapshot.stashes.length, 1);
    assert.equal(snapshot.stashes[0].ref, "stash@{0}");
    assert.match((await service.stash(repo, { ref: "stash@{0}" })).diff, /stash this/);
    await service.execute(await service.prepare(repo, "stash_apply", { ref: "stash@{0}" }));
    await assert.rejects(service.prepare(repo, "switch_branch", { branch: "feature/demo" }), /clean working tree/);
    await service.execute(await service.prepare(repo, "stash_push", { message: "second stash" }));
    assert.equal((await service.snapshot(repo)).stashes.length, 2);
    await service.execute(await service.prepare(repo, "stash_pop", { ref: "stash@{0}" }));
    assert.equal((await service.snapshot(repo)).stashes.length, 1);
    await runGit(repo, ["worktree", "add", path.join(root, "linked"), "feature/demo"]);
    assert.equal((await service.snapshot(repo)).worktrees.length, 2);
});

test("fetch/push/pull only through a local disposable remote", async (t) => {
    const { repo, root } = await fixture(t);
    const remote = path.join(root, "remote.git");
    await mkdir(remote);
    await runGit(remote, ["init", "--bare", "--initial-branch=main"]);
    await runGit(repo, ["remote", "add", "origin", remote]);
    await runGit(repo, ["push", "--set-upstream", "origin", "main"]);
    await service.execute(await service.prepare(repo, "fetch", { remote: "origin" }));
    await service.execute(await service.prepare(repo, "pull", {}));
    await writeFile(path.join(repo, "pushed.txt"), "local-only sample\n");
    await service.execute(await service.prepare(repo, "stage", { paths: [] }));
    await service.execute(await service.prepare(repo, "commit", { message: "Local remote sample" + trailer }));
    await service.execute(await service.prepare(repo, "push", {}));
    const snapshot = await service.snapshot(repo);
    assert.equal(snapshot.ahead, 0);
    assert.equal(snapshot.upstream, "origin/main");
    assert.equal(snapshot.remotes[0].name, "origin");
});

test("merge conflict status, detached history and include-untracked stash", async (t) => {
    const { repo } = await fixture(t);
    await runGit(repo, ["switch", "-c", "conflicting"]);
    await writeFile(path.join(repo, "src", "sample.txt"), "topic version\n");
    await runGit(repo, ["add", "--all"]);
    await runGit(repo, ["commit", "-m", "Topic sample" + trailer]);
    await runGit(repo, ["switch", "main"]);
    await writeFile(path.join(repo, "src", "sample.txt"), "main version\n");
    await runGit(repo, ["add", "--all"]);
    await runGit(repo, ["commit", "-m", "Main sample" + trailer]);
    await runGit(repo, ["merge", "--no-edit", "conflicting"], { codes: [1] });
    const conflict = await service.snapshot(repo);
    assert.equal(conflict.changes[0].conflict, true);
    assert.deepEqual(conflict.inProgress, ["merge"]);
    await assert.rejects(service.prepare(repo, "commit", { message: "blocked" }), /in-progress/);
    await runGit(repo, ["merge", "--abort"]);
    await runGit(repo, ["switch", "--detach", "HEAD"]);
    assert.equal((await service.status(repo)).branch, "(detached)");
    assert.equal((await service.history(repo, { ref: "--all" })).commits.length, 3);
    await writeFile(path.join(repo, "untracked.txt"), "stash untracked\n");
    await service.execute(await service.prepare(repo, "stash_push", { includeUntracked: true }));
    assert.match((await service.stash(repo, { ref: "stash@{0}" })).diff, /stash untracked/);
});

test("ref changes invalidate confirmations and unsupported destructive operations are refused", async (t) => {
    const { repo } = await fixture(t);
    await runGit(repo, ["branch", "topic"]);
    const plan = await service.prepare(repo, "switch_branch", { branch: "topic" });
    await runGit(repo, ["tag", "changed-since-confirmation"]);
    await assert.rejects(service.execute(plan), /changed since the preview/);
    assert.equal((await service.status(repo)).branch, "main");
    await assert.rejects(service.prepare(repo, "reset_hard", {}), /Unsupported Git operation/);
    await assert.rejects(service.prepare(repo, "push", {}), /existing upstream/);
    await assert.rejects(service.prepare(repo, "create_branch", { name: "--bad" }), /Invalid Git reference/);
    await assert.rejects(service.prepare(repo, "stage", { paths: ["src"] }), /no longer changed/);
});

test("HTTP token/origin checks, one-shot confirmation and persisted repository identity", async (t) => {
    const { repo, root } = await fixture(t);
    const store = new RepositoryStore(path.join(root, "catalog"));
    await store.add(repo);
    assert.equal((await new RepositoryStore(path.join(root, "catalog")).catalog()).repositories.length, 1);
    const server = await startServer({ service, store, initialRepo: repo });
    t.after(() => server.close());
    const url = new URL(server.url);
    const token = url.searchParams.get("token");
    const api = async (data, headers = {}) => {
        const response = await fetch(`${url.origin}/api`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Git-Workbench-Token": token, ...headers },
            body: JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
    };
    assert.equal((await api({ action: "catalog" }, { "X-Git-Workbench-Token": "invalid" })).status, 403);
    assert.equal((await api({ action: "catalog" }, { Origin: "https://example.invalid" })).status, 403);
    assert.equal((await api({ action: "catalog" })).body.repositories.length, 1);
    assert.equal((await api({ action: "select_repository", repo })).body.lastSelectedRepo, repo);
    assert.equal((await new RepositoryStore(path.join(root, "catalog")).catalog()).lastSelectedRepo, repo);
    assert.equal((await api({ action: "read", repo, view: "snapshot" })).body.branch, "main");
    assert.equal((await api({ action: "execute", confirmationId: "invented" })).body.error.code, "confirmation_expired");
    await writeFile(path.join(repo, "http.txt"), "confirm through API\n");
    const preview = await api({ action: "prepare", repo, operation: "stage", params: { paths: ["http.txt"] } });
    assert.equal(preview.status, 200);
    assert.match(preview.body.commands[0], /^git add /);
    const result = await api({ action: "execute", confirmationId: preview.body.confirmationId });
    assert.equal(result.status, 200);
    assert.equal(result.body.snapshot.changes[0].index, "A");
    assert.equal((await api({ action: "execute", confirmationId: preview.body.confirmationId })).body.error.code, "confirmation_expired");
    await store.remove(repo);
    assert.equal((await store.catalog()).lastSelectedRepo, undefined);
    await assert.rejects(store.resolve(repo), /before reading/);
    assert.equal(await readFile(path.join(repo, "http.txt"), "utf8"), "confirm through API\n");
});

test("catalog canonicalizes subdirectories and persists across store instances", async (t) => {
    const { repo, root } = await fixture(t);
    const directory = path.join(root, "shared catalog");
    const first = new RepositoryStore(directory);
    const second = new RepositoryStore(directory);
    await first.add(repo);
    await second.add(path.join(repo, "src"));
    assert.equal((await first.catalog()).repositories.length, 1);
    await first.remove(repo);
    assert.equal((await second.catalog()).repositories.length, 0);
});

test("initial context prefers session worktree and its current branch over the last selection", async (t) => {
    const { repo, root } = await fixture(t);
    const store = new RepositoryStore(path.join(root, "catalog"));
    await store.add(repo);
    await store.remember(repo);
    const worktree = path.join(root, "session-worktree");
    await runGit(repo, ["worktree", "add", "-b", "feature/session", worktree]);
    const context = await initialContext({ workingDirectory: path.join(worktree, "src") }, store);
    assert.equal(context.initialRepo, worktree);
    assert.equal(context.source, "session");
    assert.equal((await service.status(context.initialRepo)).branch, "feature/session");
    assert.equal((await service.status(repo)).branch, "main");
    assert.equal((await store.catalog()).lastSelectedRepo, repo);
    const explicit = await initialContext({ explicitRepo: repo, workingDirectory: worktree }, store);
    assert.equal(explicit.initialRepo, repo);
    assert.equal(explicit.source, "explicit");
    await runGit(worktree, ["switch", "--detach", "HEAD"]);
    const detached = await initialContext({ workingDirectory: worktree }, store);
    assert.equal(detached.initialRepo, worktree);
    assert.equal((await service.status(worktree)).branch, "(detached)");
});

test("ordinary chat uses the last manual selection and never invents a current repository", async (t) => {
    const { repo, root } = await fixture(t);
    const directory = path.join(root, "catalog");
    const store = new RepositoryStore(directory);
    await store.add(repo);
    const empty = await initialContext({ workingDirectory: root }, store);
    assert.equal(empty.initialRepo, "");
    assert.equal(empty.source, "none");
    await store.remember(repo);
    const restored = await initialContext({ workingDirectory: root }, new RepositoryStore(directory));
    assert.equal(restored.initialRepo, repo);
    assert.equal(restored.source, "last-selected");
    const withoutContext = await initialContext({}, store);
    assert.equal(withoutContext.initialRepo, repo);
    await store.remove(repo);
    assert.equal((await initialContext({ workingDirectory: root }, store)).source, "none");
    await assert.rejects(initialContext({ workingDirectory: path.join(root, "missing") }, store), /ENOENT/);
});
