import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, link, utimes } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DOCUMENT_FILES, EPOCH, MARKETPLACE, NAME, OPTIONAL_BINARY_FILES, REPOSITORY, RUNTIME_FILES, SOURCE_FILES,
  jsonBytes, relativePath, sha256, validateProject, validateVersion, validateReleaseIdentity,
} from "../scripts/lib.mjs";
import { pack, tarGzip } from "../scripts/pack.mjs";
import { pinMarketplace, verifyPublishedRelease } from "../scripts/pin-marketplace.mjs";
import { verifyRelease } from "../scripts/verify-release.mjs";
import { fixture, mutateJson, projectRoot, untar } from "./packaging-helpers.mjs";

const VERSION = JSON.parse(await readFile(path.join(projectRoot, "plugin.json"), "utf8")).version;
const SHA = "1234567890abcdef1234567890abcdef12345678";
const identity = { version: VERSION, tag: `v${VERSION}`, sha: SHA };
const archiveName = (kind) => `git-workbench-${kind}-${VERSION}.tar.gz`;
const DEMO_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");

function publishedRequest(overrides = {}) {
  return async (endpoint) => {
    assert.ok(endpoint.startsWith(`/repos/${REPOSITORY}/`));
    if (endpoint.includes("/releases/tags/")) return {
      tag_name: identity.tag, draft: false, published_at: "2026-09-17T00:00:00Z",
      prerelease: VERSION.split("+")[0].includes("-"), ...overrides.release,
    };
    if (endpoint.includes("/commits/")) return { sha: SHA, ...overrides.commit };
    if (endpoint.includes("/contents/plugin.json")) return {
      type: "file", encoding: "base64",
      content: jsonBytes({ name: NAME, version: VERSION, extensions: "extensions", ...overrides.plugin }).toString("base64"),
      ...overrides.file,
    };
    throw new Error(`Unexpected request: ${endpoint}`);
  };
}

test("valid legacy manifests and private dependency-free tooling stay consistent", async (t) => {
  const f = await fixture(t);
  const project = await validateProject(f.root);
  assert.equal(project.version, VERSION);
  assert.equal(project.plugin.extensions, "extensions");
  assert.equal(project.marketplace.plugins[0].source, "./");
  assert.deepEqual([...project.files.keys()], SOURCE_FILES);
});

test("SemVer, immutable release identity, and portable path inputs fail closed", () => {
  for (const version of ["0.1.0-preview.1", "1.2.3", "1.0.0-rc.2+build.5"]) assert.equal(validateVersion(version), version);
  for (const version of ["", "v1.0.0", "01.0.0", "1.2", "1.2.3-01", "1.2.3-a..b", "1.2.3\n", "1.2.3/escape"]) {
    assert.throws(() => validateVersion(version));
  }
  assert.deepEqual(validateReleaseIdentity(VERSION, identity.tag, SHA.toUpperCase()), identity);
  for (const [tag, sha] of [["main", SHA], [`v${VERSION}`, "abc123"], [`v${VERSION}`, "0".repeat(40)], [`v${VERSION}`, "../" + SHA], ["v9.9.9", SHA]]) {
    assert.throws(() => validateReleaseIdentity(VERSION, tag, sha));
  }
  for (const unsafe of ["", ".", "..", "../outside", "safe/../outside", "safe\\..\\outside", "/root", "\\root", "C:\\escape", "C:escape", "\\\\server\\share", "a//b", "a/./b", "a\\", "a:b", "a\0b", "name.", "AUX", "con.txt", "a/NUL", "a\n"]) {
    assert.throws(() => relativePath(unsafe), undefined, unsafe);
  }
  assert.equal(relativePath("safe\\nested-folder"), "safe/nested-folder");
});

test("manifest inconsistencies, SDK dependencies, and missing runtime imports are rejected", async (t) => {
  const cases = [
    ["plugin.json", (json) => { json.name = "other"; }],
    ["plugin.json", (json) => { json.version = "1.2.3"; }],
    ["plugin.json", (json) => { json.$schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"; }],
    ["plugin.json", (json) => { json.extensions = { paths: ["extensions"], exclusive: true }; }],
    ["package.json", (json) => { json.private = false; }],
    ["package.json", (json) => { json.dependencies = { "@github/copilot-sdk": "*" }; }],
    [MARKETPLACE, (json) => { json.plugins.push(json.plugins[0]); }],
    [MARKETPLACE, (json) => { json.metadata.version = "9.0.0"; }],
    [MARKETPLACE, (json) => { json.plugins[0].version = "9.0.0"; }],
    [MARKETPLACE, (json) => { json.plugins[0].source = "../outside"; }],
    [MARKETPLACE, (json) => { json.plugins[0].source = { source: "github", repo: REPOSITORY, ref: identity.tag }; }],
  ];
  for (const [file, change] of cases) {
    const f = await fixture(t);
    await mutateJson(f, file, change);
    await assert.rejects(validateProject(f.root));
  }
  const missing = await fixture(t);
  await rm(path.join(missing.root, "extensions", NAME, "preferences.mjs"));
  await assert.rejects(pack({ root: missing.root }), /ENOENT/);
  await assert.rejects(access(path.join(missing.root, "dist")), /ENOENT/);
  const injected = await fixture(t);
  await injected.put(`extensions/${NAME}/app.js`, 'import "./unbundled.js";\n');
  await assert.rejects(validateProject(injected.root), /Unbundled runtime import/);
});

test("explicit archive allowlists exclude tests, state, repositories, logs, SDK, and arbitrary folders", async (t) => {
  const f = await fixture(t);
  const excluded = [
    "secret.txt", "package-lock.json", ".git/config", "node_modules/@github/copilot-sdk/index.js",
    "tests/example.test.mjs", ".github/extensions/active/extension.mjs",
    `extensions/${NAME}/git.test.mjs`, `extensions/${NAME}/preferences.test.mjs`,
    `extensions/${NAME}/repositories.json`, `extensions/${NAME}/preferences.json`,
    `extensions/${NAME}/debug.log`, `extensions/${NAME}/artifacts/state.json`,
    `extensions/${NAME}/repos/private/README.md`, `extensions/${NAME}/node_modules/sdk/index.js`,
  ];
  for (const file of excluded) await f.put(file, "PRIVATE_SENTINEL_DO_NOT_SHIP");
  const result = await pack({ root: f.root });
  assert.equal(result.artifacts.length, 4);
  for (const kind of ["plugin", "canvas"]) {
    const entries = untar(await f.read(`dist/${archiveName(kind)}`));
    const actual = entries.map((entry) => entry.path);
    const expected = kind === "plugin" ? SOURCE_FILES.map((file) => `${NAME}/${file}`)
      : [...RUNTIME_FILES, ...DOCUMENT_FILES].map((file) => `${NAME}/${file}`);
    assert.deepEqual(actual, expected.sort());
    for (const entry of entries) {
      assert.ok(!entry.bytes.includes("PRIVATE_SENTINEL_DO_NOT_SHIP"));
      assert.equal(entry.mode, 0o644);
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
      assert.equal(entry.mtime, EPOCH);
    }
    assert.ok(!actual.some((name) => name.endsWith("/package.json") || name.includes("node_modules") || name.endsWith(".test.mjs")));
  }
  await assert.rejects(access(path.join(f.root, ".git", "HEAD")), /ENOENT/);
});

test("archives are reproducible across output paths, mtimes, and CRLF checkouts with verifiable integrity", async (t) => {
  const f = await fixture(t);
  await pack({ root: f.root, out: "first" });
  for (const file of SOURCE_FILES) {
    const contents = (await f.read(file)).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    await f.put(file, contents);
    await utimes(path.join(f.root, ...file.split("/")), new Date("2030-01-01"), new Date("2030-01-01"));
  }
  await pack({ root: f.root, out: "second" });
  await pack({ root: f.root, out: "second" });
  for (const name of [archiveName("plugin"), archiveName("canvas"), "integrity.json", "SHA256SUMS"]) {
    assert.deepEqual(await f.read(`first/${name}`), await f.read(`second/${name}`));
  }
  const integrity = JSON.parse((await f.read("first/integrity.json")).toString("utf8"));
  assert.equal(integrity.version, VERSION);
  for (const archive of integrity.archives) {
    const bytes = await f.read(`first/${archive.filename}`);
    assert.equal(archive.sha256, sha256(bytes));
    assert.equal(archive.bytes, bytes.length);
    assert.equal(archive.integrity, `sha256-${Buffer.from(archive.sha256, "hex").toString("base64")}`);
    const entries = untar(bytes);
    assert.deepEqual(archive.files, entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes) })));
  }
  for (const line of (await f.read("first/SHA256SUMS")).toString("utf8").trimEnd().split("\n")) {
    const [hash, name] = line.split("  ");
    assert.equal(hash, sha256(await f.read(`first/${name}`)));
  }
});

test("only the optional reviewed demo PNG is included, with unchanged binary bytes and hashes", async (t) => {
  assert.deepEqual(OPTIONAL_BINARY_FILES, ["assets/demo.png"]);
  const f = await fixture(t);
  await f.put("assets/demo.png", DEMO_PNG);
  await f.put("assets/private.png", DEMO_PNG);
  await f.put("assets/nested/demo.png", DEMO_PNG);
  await f.put("other/demo.png", DEMO_PNG);
  await pack({ root: f.root, out: "first" });
  await utimes(path.join(f.root, "assets", "demo.png"), new Date("2030-01-01"), new Date("2030-01-01"));
  await pack({ root: f.root, out: "second" });
  const integrity = JSON.parse((await f.read("first/integrity.json")).toString("utf8"));
  for (const kind of ["plugin", "canvas"]) {
    const archive = await f.read(`first/${archiveName(kind)}`);
    assert.deepEqual(archive, await f.read(`second/${archiveName(kind)}`));
    const images = untar(archive).filter((entry) => entry.path.endsWith(".png"));
    assert.equal(images.length, 1);
    assert.equal(images[0].path, `${NAME}/assets/demo.png`);
    assert.deepEqual(images[0].bytes, DEMO_PNG);
    const recorded = integrity.archives.find((entry) => entry.kind === kind).files.find((entry) => entry.path === `${NAME}/assets/demo.png`);
    assert.equal(recorded.sha256, sha256(DEMO_PNG));
    assert.equal(recorded.bytes, DEMO_PNG.length);
  }
  await f.put("assets/demo.png", "not a PNG");
  await assert.rejects(pack({ root: f.root }), /Expected a PNG/);
  await f.put("assets/demo.png", DEMO_PNG);
  await f.put("assets/preview.svg", DEMO_PNG);
  await assert.rejects(pack({ root: f.root }));
});

test("optional image paths receive the same link protections as required sources", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.put("assets/demo.png", DEMO_PNG);
  await link(path.join(outside.root, "assets", "demo.png"), path.join(f.root, "assets", "demo.png"));
  await assert.rejects(pack({ root: f.root }), /non-hardlinked/);
  await rm(path.join(f.root, "assets", "demo.png"));
  await symlink(outside.root, path.join(f.root, "assets", "demo.png"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(pack({ root: f.root }), /Symlinks|junctions|Redirected/);
});

test("README references make the explicit demo image required before any archive is written", async (t) => {
  const f = await fixture(t);
  await f.put("README.md", "![Synthetic browser demo](assets/demo.png)\n");
  await assert.rejects(pack({ root: f.root }), /README references missing distribution asset: assets\/demo\.png/);
  await assert.rejects(access(path.join(f.root, "dist")), /ENOENT/);
  await f.put("assets/demo.png", DEMO_PNG);
  await pack({ root: f.root });
  assert.ok(untar(await f.read(`dist/${archiveName("plugin")}`)).some((entry) => entry.path === `${NAME}/assets/demo.png`));
});

test("valid SemVer build metadata is preserved in artifact filenames and aligned manifests", async (t) => {
  const f = await fixture(t);
  const version = "1.2.3-rc.1+build.7";
  for (const file of ["plugin.json", "package.json"]) await mutateJson(f, file, (json) => { json.version = version; });
  await mutateJson(f, MARKETPLACE, (json) => {
    json.metadata.version = version;
    json.plugins[0].version = version;
  });
  const result = await pack({ root: f.root });
  assert.equal(result.version, version);
  assert.ok(result.artifacts.includes(`git-workbench-plugin-${version}.tar.gz`));
});

test("both archive layouts contain importable runtime modules and a discoverable entry point", async (t) => {
  const f = await fixture(t);
  await pack({ root: f.root });
  for (const kind of ["plugin", "canvas"]) {
    const entries = untar(await f.read(`dist/${archiveName(kind)}`));
    for (const entry of entries) await f.put(`extracted-${kind}/${entry.path}`, entry.bytes);
    const bundleRoot = path.join(f.root, `extracted-${kind}`, NAME);
    const runtimeRoot = kind === "plugin" ? path.join(bundleRoot, "extensions", NAME) : bundleRoot;
    if (kind === "plugin") {
      const plugin = JSON.parse(await readFile(path.join(bundleRoot, "plugin.json"), "utf8"));
      assert.equal(plugin.extensions, "extensions");
      assert.equal(plugin.version, VERSION);
    }
    const syntax = spawnSync(process.execPath, ["--check", path.join(runtimeRoot, "extension.mjs")], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    const server = await import(pathToFileURL(path.join(runtimeRoot, "server.mjs")).href);
    assert.equal(typeof server.startServer, "function");
    const git = await import(pathToFileURL(path.join(runtimeRoot, "git.mjs")).href);
    assert.equal(typeof git.GitService, "function");
    await access(path.join(runtimeRoot, "app.js"));
    await access(path.join(runtimeRoot, "styles.css"));
  }
});

test("output traversal, absolute paths, and source collisions are rejected before writes", async (t) => {
  const f = await fixture(t);
  for (const out of ["../escaped", "dist/../../escaped", path.resolve(f.root, "absolute"), "C:\\escape", "\\\\server\\share", "docs/build", ".git", "extensions", "plugin.json", "NUL"]) {
    await assert.rejects(pack({ root: f.root, out }));
  }
  assert.equal((await f.read("plugin.json")).toString("utf8").includes('"name": "git-workbench"'), true);
});

test("symlink/junction input, ancestor, root, and output paths are refused", async (t) => {
  for (const location of ["runtime", "input-parent", "root", "output", "output-parent"]) {
    const f = await fixture(t);
    const outside = await fixture(t);
    const makeJunction = (target, destination) => symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
    if (location === "runtime") {
      await rm(path.join(f.root, "extensions", NAME), { recursive: true });
      await makeJunction(path.join(outside.root, "extensions", NAME), path.join(f.root, "extensions", NAME));
    } else if (location === "input-parent") {
      await rm(path.join(f.root, "extensions"), { recursive: true });
      await makeJunction(path.join(outside.root, "extensions"), path.join(f.root, "extensions"));
    } else if (location === "root") {
      await makeJunction(f.root, path.join(outside.root, "linked-root"));
      await assert.rejects(pack({ root: path.join(outside.root, "linked-root") }), /Symlinks|junctions|Redirected/);
      await assert.rejects(pack({ root: path.join(outside.root, "linked-root", "child") }), /Symlinks|junctions|Redirected/);
      continue;
    } else {
      await makeJunction(outside.root, path.join(f.root, "dist"));
    }
    await assert.rejects(pack({ root: f.root, out: location === "output-parent" ? "dist/nested" : "dist" }), /Symlinks|junctions|Redirected/);
    await assert.rejects(access(path.join(outside.root, archiveName("plugin"))), /ENOENT/);
  }
});

test("file links and hardlinks cannot leak input or overwrite output targets", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  const source = path.join(outside.root, "README.md");
  await rm(path.join(f.root, "README.md"));
  await link(source, path.join(f.root, "README.md"));
  await assert.rejects(pack({ root: f.root }), /non-hardlinked/);
  await rm(path.join(f.root, "README.md"));
  await f.put("README.md", "safe");
  await mkdir(path.join(f.root, "dist"));
  await link(source, path.join(f.root, "dist", archiveName("plugin")));
  await assert.rejects(pack({ root: f.root }), /non-hardlinked/);
  assert.equal((await readFile(source, "utf8")), "README.md: test distribution documentation\n");
  await rm(path.join(f.root, "dist", archiveName("plugin")));
  try {
    await symlink(source, path.join(f.root, "dist", archiveName("plugin")), "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.diagnostic("Windows file-symlink privilege unavailable; junction and hardlink protections were exercised.");
      return;
    }
    throw error;
  }
  await assert.rejects(pack({ root: f.root }), /Symlinks|junctions|Redirected/);
  await rm(path.join(f.root, "dist", archiveName("plugin")));
  await rm(path.join(f.root, "README.md"));
  await symlink(source, path.join(f.root, "README.md"), "file");
  await assert.rejects(pack({ root: f.root }), /Symlinks|junctions|Redirected/);
});

test("tar writer refuses archive path escapes and duplicate members", () => {
  const bytes = Buffer.from("payload");
  for (const name of ["../bad", "/absolute", "C:\\escape", "a/../bad"]) {
    assert.throws(() => tarGzip([{ path: name, bytes }]));
  }
  assert.throws(() => tarGzip([{ path: "safe", bytes }, { path: "safe", bytes }]), /duplicate/);
});

test("marketplace pin verifies a real published release then aligns immutable ref and SHA", async (t) => {
  const f = await fixture(t);
  const result = await pinMarketplace({ root: f.root, ...identity, request: publishedRequest() });
  assert.deepEqual(result, identity);
  const { marketplace } = await validateProject(f.root);
  assert.deepEqual(marketplace.plugins[0].source, { source: "github", repo: REPOSITORY, ref: identity.tag, sha: SHA });
  assert.equal(marketplace.plugins[0].version, VERSION);
  assert.equal(marketplace.metadata.version, VERSION);
  await pinMarketplace({ root: f.root, ...identity, request: publishedRequest() });
  await assert.rejects(pinMarketplace({ root: f.root, ...identity, version: "9.9.9", tag: "v9.9.9", request: publishedRequest() }), /Supplied version/);
});

test("marketplace pin refuses unpublished, mismatched, moved, malformed, or unverifiable releases without edits", async (t) => {
  const cases = [
    { release: { draft: true } },
    { release: { published_at: null } },
    { release: { tag_name: "v9.9.9" } },
    { release: { prerelease: !VERSION.split("+")[0].includes("-") } },
    { commit: { sha: "f".repeat(40) } },
    { plugin: { version: "9.9.9" } },
    { plugin: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" } },
    { file: { type: "symlink" } },
  ];
  const f = await fixture(t);
  const before = await f.read(MARKETPLACE);
  for (const change of cases) {
    await assert.rejects(pinMarketplace({ root: f.root, ...identity, request: publishedRequest(change) }));
    assert.deepEqual(await f.read(MARKETPLACE), before);
  }
  await assert.rejects(pinMarketplace({ root: f.root, ...identity, request: async () => { throw new Error("not published"); } }), /not published/);
  assert.deepEqual(await f.read(MARKETPLACE), before);
  await assert.rejects(verifyPublishedRelease({ ...identity, sha: "short" }, () => assert.fail("Invalid identity must not make a request")));
});

test("marketplace pin refuses concurrent local edits and symlinked manifest ancestors", async (t) => {
  const f = await fixture(t);
  let changed = false;
  const request = async (endpoint) => {
    if (!changed) {
      changed = true;
      await mutateJson(f, MARKETPLACE, (json) => { json.metadata.description = "Concurrent edit"; });
    }
    return publishedRequest()(endpoint);
  };
  await assert.rejects(pinMarketplace({ root: f.root, ...identity, request }), /changed during verification/);
  assert.equal(JSON.parse((await f.read(MARKETPLACE)).toString("utf8")).metadata.description, "Concurrent edit");
  const outside = await fixture(t);
  await rm(path.join(f.root, ".github"), { recursive: true });
  await symlink(path.join(outside.root, ".github"), path.join(f.root, ".github"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(pinMarketplace({ root: f.root, ...identity, request: () => assert.fail("Unsafe path must not make a request") }), /Symlinks|junctions|Redirected/);
});

test("CLI rejects unknown arguments and invalid release requests without publishing", () => {
  for (const [script, args] of [
    ["pack.mjs", ["--out", "../outside"]],
    ["pack.mjs", ["--unknown", "value"]],
    ["pack.mjs", ["--out", "dist", "--out", "elsewhere"]],
    ["pin-marketplace.mjs", ["--version", VERSION, "--tag", "main", "--sha", SHA]],
    ["verify-release.mjs", ["--tag", "main"]],
  ]) {
    const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", script), ...args], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 1, `${script}: ${result.stdout} ${result.stderr}`);
  }
});

test("release verification requires aligned tag, clean checkout, and actual triggering commit", async (t) => {
  const f = await fixture(t);
  const readGit = (args) => {
    if (args[0] === "status") return "";
    assert.equal(args[0], "rev-parse");
    assert.ok(["HEAD^{commit}", `refs/tags/${identity.tag}^{commit}`].includes(args[2]));
    return SHA;
  };
  const result = await verifyRelease({ root: f.root, tag: identity.tag, "expected-sha": SHA, readGit });
  assert.deepEqual(result, { ...identity, prerelease: VERSION.split("+")[0].includes("-") });
  await assert.rejects(verifyRelease({ root: f.root, tag: "main", readGit }), /manifest version/);
  await assert.rejects(verifyRelease({ root: f.root, tag: identity.tag, "expected-sha": "f".repeat(40), readGit }), /triggering commit/);
  await assert.rejects(verifyRelease({
    root: f.root, tag: identity.tag,
    readGit: (args) => args[2]?.startsWith("refs/tags/") ? "f".repeat(40) : readGit(args),
  }), /actual checked-out commit/);
  await assert.rejects(verifyRelease({
    root: f.root, tag: identity.tag,
    readGit: (args) => args[0] === "status" ? "?? uncommitted-file" : readGit(args),
  }), /clean, committed checkout/);
});

test("release workflow separates verification from draft-only publishing with minimal permissions", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /publish:[\s\S]*needs: verify/);
  assert.match(workflow, /publish:[\s\S]*permissions:\s+contents: write/);
  assert.match(workflow, /"--verify-tag", "--draft"/);
  assert.match(workflow, /Remote tag moved after verification/);
  assert.match(workflow, /--expected-sha/);
  assert.match(workflow, /confirmation == 'create-draft'/);
  assert.doesNotMatch(workflow, /pull_request_target|npm publish|git push/);
});
