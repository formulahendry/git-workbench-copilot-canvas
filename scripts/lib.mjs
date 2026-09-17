import { constants } from "node:fs";
import { lstat, realpath, open, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const NAME = "git-workbench";
export const REPOSITORY = "formulahendry/git-workbench-copilot-canvas";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const MARKETPLACE = ".github/plugin/marketplace.json";
export const EPOCH = 946684800;
export const RUNTIME_FILES = Object.freeze([
  "extension.mjs", "context.mjs", "git.mjs", "server.mjs", "store.mjs",
  "preferences.mjs", "app.js", "index.html", "styles.css",
]);
export const DOCUMENT_FILES = Object.freeze([
  "LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md",
  "docs/RELEASING.md", "assets/preview.svg",
]);
export const OPTIONAL_BINARY_FILES = Object.freeze(["assets/demo.png"]);
export const SOURCE_FILES = Object.freeze([
  "plugin.json", ...DOCUMENT_FILES,
  ...RUNTIME_FILES.map((file) => `extensions/${NAME}/${file}`),
]);
export const TOOL_FILES = Object.freeze([
  "scripts/lib.mjs", "scripts/pack.mjs", "scripts/check.mjs", "scripts/validate.mjs",
  "scripts/pin-marketplace.mjs", "scripts/verify-release.mjs", "tests/packaging.test.mjs",
  "tests/packaging-helpers.mjs",
]);

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateVersion(version) {
  requireCondition(typeof version === "string" && version.length <= 64, "Version must be a SemVer string of at most 64 characters.");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  requireCondition(match && match[0] === version && !match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0"), `Invalid semantic version: ${version}`);
  return version;
}

export function validateReleaseIdentity(version, tag, sha) {
  validateVersion(version);
  requireCondition(tag === `v${version}`, "Release tag must be exactly v<version>.");
  requireCondition(typeof sha === "string" && sha.length === 40 && /^[a-f0-9]{40}$/i.test(sha) && !/^0{40}$/.test(sha), "Release SHA must be a full, nonzero 40-character commit SHA.");
  return { version, tag, sha: sha.toLowerCase() };
}

export function relativePath(input) {
  requireCondition(typeof input === "string" && input.length > 0 && !path.posix.isAbsolute(input) && !path.win32.isAbsolute(input), "Only relative paths are accepted.");
  const parts = input.replaceAll("\\", "/").split("/");
  requireCondition(parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !/[^A-Za-z0-9_.+@-]/.test(part) && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), `Unsafe relative path: ${input}`);
  return parts.join("/");
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

export async function assertSafeAbsolute(absolute, { missing = false, kind } = {}) {
  requireCondition(path.isAbsolute(absolute), "Internal path must be absolute.");
  const parsed = path.parse(absolute);
  const parts = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let finalStat = await lstat(current);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try {
      finalStat = await lstat(current);
    } catch (error) {
      if (missing && error.code === "ENOENT") return undefined;
      throw error;
    }
    requireCondition(!finalStat.isSymbolicLink(), `Symlinks and junctions are forbidden: ${current}`);
    requireCondition(samePath(await realpath(current), current), `Redirected filesystem path is forbidden: ${current}`);
    const last = index === parts.length - 1;
    requireCondition(last || finalStat.isDirectory(), `Ancestor must be a directory: ${current}`);
    if (last && kind === "directory") requireCondition(finalStat.isDirectory(), `Expected directory: ${current}`);
    if (last && kind === "file") requireCondition(finalStat.isFile() && finalStat.nlink === 1, `Expected a regular, non-hardlinked file: ${current}`);
  }
  return finalStat;
}

export async function safePath(root, relative, options) {
  const base = path.resolve(root);
  const target = path.join(base, ...relativePath(relative).split("/"));
  await assertSafeAbsolute(target, options);
  return target;
}

export async function readSafe(root, relative) {
  const target = await safePath(root, relative, { kind: "file" });
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const actual = await handle.stat();
    const current = await assertSafeAbsolute(target, { kind: "file" });
    requireCondition(actual.dev === current.dev && actual.ino === current.ino, `File changed during read: ${relative}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    requireCondition(after.size === actual.size && after.mtimeMs === actual.mtimeMs, `File changed during read: ${relative}`);
    return data;
  } finally {
    await handle.close();
  }
}

export async function makeSafeDirectory(root, relative) {
  await assertSafeAbsolute(path.resolve(root), { kind: "directory" });
  const parts = relativePath(relative).split("/");
  for (let i = 1; i <= parts.length; i++) {
    const target = await safePath(root, parts.slice(0, i).join("/"), { missing: true, kind: "directory" });
    try { await mkdir(target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await assertSafeAbsolute(target, { kind: "directory" });
  }
}

export async function writeSafe(root, relative, content) {
  const target = await safePath(root, relative, { missing: true, kind: "file" });
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o644);
  try {
    const actual = await handle.stat();
    const current = await assertSafeAbsolute(target, { kind: "file" });
    requireCondition(actual.dev === current.dev && actual.ino === current.ino, `File changed during write: ${relative}`);
    await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const isMain = (url) => process.argv[1] && samePath(fileURLToPath(url), process.argv[1]);

export function options(args, permitted) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    requireCondition(key?.startsWith("--") && permitted.includes(key.slice(2)) && args[i + 1] && !args[i + 1].startsWith("--") && !(key.slice(2) in result), `Invalid or duplicate option: ${key}`);
    result[key.slice(2)] = args[i + 1];
  }
  return result;
}

export function reportFailure(error) {
  console.error(error.message);
  process.exitCode = 1;
}

export async function validateProject(root) {
  const readJson = async (file) => JSON.parse((await readSafe(root, file)).toString("utf8"));
  const plugin = await readJson("plugin.json");
  const pkg = await readJson("package.json");
  const marketplace = await readJson(MARKETPLACE);
  validateVersion(plugin.version);
  requireCondition(plugin.name === NAME && pkg.name === NAME, "Plugin/package name must be git-workbench.");
  requireCondition(plugin.extensions === "extensions" && !("$schema" in plugin), "Use the legacy extensions directory manifest, without an Agent Plugins schema or exclusive suppression.");
  requireCondition(plugin.version === pkg.version, "Plugin/package versions must match.");
  requireCondition(plugin.license === "MIT" && pkg.license === "MIT" && plugin.author?.name === "formulahendry" && pkg.author === "formulahendry", "License/author metadata must match.");
  requireCondition(plugin.homepage === REPOSITORY_URL && plugin.repository === REPOSITORY_URL && pkg.repository?.url === REPOSITORY_URL, "Repository metadata must match.");
  requireCondition(pkg.private === true && ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"].every((key) => !(key in pkg)), "The package is private tooling only and must not bundle dependencies or the host SDK.");
  requireCondition(marketplace.name === `${NAME}-marketplace` && marketplace.owner?.name === "formulahendry", "Marketplace name/owner must match.");
  requireCondition(marketplace.metadata?.version === plugin.version && Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1, "Marketplace must contain exactly one plugin with aligned metadata version.");
  const entry = marketplace.plugins[0];
  requireCondition(entry.name === NAME && entry.version === plugin.version && entry.license === "MIT" && entry.author?.name === "formulahendry" && entry.homepage === REPOSITORY_URL && entry.repository === REPOSITORY_URL, "Marketplace entry metadata/version must match.");
  if (entry.source !== "./") {
    requireCondition(entry.source && typeof entry.source === "object" && !Array.isArray(entry.source), "Marketplace source must be ./ or a pinned GitHub object.");
    requireCondition(Object.keys(entry.source).sort().join(",") === "ref,repo,sha,source" && entry.source.source === "github" && entry.source.repo === REPOSITORY, "Marketplace source must refer to the expected repository root.");
    validateReleaseIdentity(plugin.version, entry.source.ref, entry.source.sha);
  }
  const files = new Map();
  for (const file of SOURCE_FILES) {
    const bytes = await readSafe(root, file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
    requireCondition(!text.includes("\0"), `Binary content is not allowed in distribution input: ${file}`);
    files.set(file, Buffer.from(text));
  }
  for (const file of OPTIONAL_BINARY_FILES) {
    const target = await safePath(root, file, { missing: true, kind: "file" });
    if (!await assertSafeAbsolute(target, { missing: true, kind: "file" })) continue;
    const bytes = await readSafe(root, file);
    requireCondition(bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Expected a PNG image: ${file}`);
    files.set(file, bytes);
  }
  const readme = files.get("README.md").toString("utf8");
  for (const file of OPTIONAL_BINARY_FILES) {
    requireCondition(files.has(file) || (!readme.includes(file) && !readme.includes(file.replaceAll("/", "\\"))), `README references missing distribution asset: ${file}`);
  }
  const runtimePrefix = `extensions/${NAME}/`;
  for (const name of RUNTIME_FILES.filter((file) => /\.(mjs|js)$/.test(file))) {
    const text = files.get(`${runtimePrefix}${name}`).toString("utf8");
    const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'])([^"']+)\1/g)];
    for (const [, , specifier] of imports) {
      if (specifier.startsWith("node:") || specifier === "@github/copilot-sdk/extension") continue;
      requireCondition(specifier.startsWith("./") && RUNTIME_FILES.includes(specifier.slice(2)), `Unbundled runtime import in ${name}: ${specifier}`);
    }
  }
  const extension = files.get(`${runtimePrefix}extension.mjs`).toString("utf8");
  requireCondition(/\bid:\s*["']git-workbench["']/.test(extension) && /\bdisplayName:\s*["']Git Workbench["']/.test(extension), "Canvas identity must match Git Workbench.");
  const html = files.get(`${runtimePrefix}index.html`).toString("utf8");
  requireCondition(html.includes("app.js") && html.includes("styles.css"), "Canvas HTML must reference the bundled app.js and styles.css.");
  return { version: plugin.version, plugin, pkg, marketplace, files };
}
