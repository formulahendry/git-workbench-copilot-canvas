import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import {
  NAME, EPOCH, DOCUMENT_FILES, OPTIONAL_BINARY_FILES, RUNTIME_FILES, SOURCE_FILES, validateProject,
  relativePath, requireCondition, makeSafeDirectory, safePath, writeSafe,
  sha256, jsonBytes, isMain, options, reportFailure,
} from "./lib.mjs";

const compareNames = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function tarGzip(entries) {
  const blocks = [];
  const names = new Set();
  for (const { path: name, bytes } of [...entries].sort(compareNames)) {
    requireCondition(relativePath(name) === name && Buffer.byteLength(name) <= 100 && !names.has(name), `Invalid or duplicate archive path: ${name}`);
    names.add(name);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const octal = (number, offset, length) => {
      const value = number.toString(8);
      requireCondition(value.length < length, "Archive entry exceeds ustar limits.");
      header.write(`${value.padStart(length - 1, "0")}\0`, offset, length, "ascii");
    };
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(EPOCH, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(0, 329, 8);
    octal(0, 337, 8);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
  archive[9] = 255; // Do not encode the builder's operating system.
  return archive;
}

export async function pack({ root = process.cwd(), out = "dist" } = {}) {
  const output = relativePath(out);
  const reserved = ["extensions", "scripts", "tests", "docs", "assets", ".git", ".github"];
  requireCondition(!reserved.includes(output.split("/")[0].toLowerCase()), "Output must not be inside source, tests, Git metadata, or documentation directories.");
  requireCondition(!SOURCE_FILES.some((file) => file.toLowerCase() === output.toLowerCase()), "Output must not overwrite a source file.");
  await safePath(root, output, { missing: true, kind: "directory" });
  const { version, files } = await validateProject(root);
  const publicFiles = [...DOCUMENT_FILES, ...OPTIONAL_BINARY_FILES.filter((file) => files.has(file))];
  const bundles = [
    {
      kind: "plugin",
      entries: [...files].map(([file, bytes]) => ({ path: `${NAME}/${file}`, bytes })),
    },
    {
      kind: "canvas",
      entries: [
        ...RUNTIME_FILES.map((file) => ({ path: `${NAME}/${file}`, bytes: files.get(`extensions/${NAME}/${file}`) })),
        ...publicFiles.map((file) => ({ path: `${NAME}/${file}`, bytes: files.get(file) })),
      ],
    },
  ];
  const artifacts = new Map();
  const integrity = {
    formatVersion: 1,
    name: NAME,
    version,
    archiveFormat: "ustar+gzip",
    timestamp: "2000-01-01T00:00:00.000Z",
    textEncoding: "Text files: UTF-8; CRLF normalized to LF. Explicitly allowlisted PNG files: original bytes.",
    archives: [],
  };
  for (const bundle of bundles) {
    const filename = `${NAME}-${bundle.kind}-${version}.tar.gz`;
    const entries = bundle.entries.sort(compareNames);
    const bytes = tarGzip(entries);
    artifacts.set(filename, bytes);
    integrity.archives.push({
      filename,
      kind: bundle.kind,
      bytes: bytes.length,
      sha256: sha256(bytes),
      integrity: `sha256-${Buffer.from(sha256(bytes), "hex").toString("base64")}`,
      files: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes) })),
    });
  }
  artifacts.set("integrity.json", jsonBytes(integrity));
  const sums = [...artifacts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([filename, bytes]) => `${sha256(bytes)}  ${filename}\n`).join("");
  artifacts.set("SHA256SUMS", Buffer.from(sums));
  // Check every output target before writing any artifacts.
  for (const filename of artifacts.keys()) await safePath(root, posix.join(output, filename), { missing: true, kind: "file" });
  await makeSafeDirectory(root, output);
  for (const [filename, bytes] of artifacts) await writeSafe(root, posix.join(output, filename), bytes);
  return { version, output, artifacts: [...artifacts.keys()] };
}

if (isMain(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2), ["out"]);
    const result = await pack(args);
    console.log(`Packed ${result.version} into ${result.output}: ${result.artifacts.join(", ")}`);
  } catch (error) { reportFailure(error); }
}
