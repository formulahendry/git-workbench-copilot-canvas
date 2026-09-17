import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DOCUMENT_FILES, NAME, MARKETPLACE, RUNTIME_FILES, relativePath } from "../scripts/lib.mjs";

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function fixture(t) {
  const base = path.join(projectRoot, ".packaging-fixtures");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const put = async (relative, data) => {
    const file = path.join(root, ...relativePath(relative).split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  for (const file of ["plugin.json", "package.json", MARKETPLACE]) {
    const bytes = await readFile(path.join(projectRoot, ...file.split("/")));
    if (file === MARKETPLACE) {
      const marketplace = JSON.parse(bytes.toString("utf8"));
      marketplace.plugins[0].source = "./";
      await put(file, `${JSON.stringify(marketplace, null, 2)}\n`);
    } else {
      await put(file, bytes);
    }
  }
  for (const file of DOCUMENT_FILES) await put(file, `${file}: test distribution documentation\n`);
  for (const file of RUNTIME_FILES) {
    await put(`extensions/${NAME}/${file}`, await readFile(path.join(projectRoot, "extensions", NAME, file)));
  }
  return { root, put, read: (file) => readFile(path.join(root, ...file.split("/"))) };
}

export async function mutateJson(f, file, change) {
  const json = JSON.parse((await f.read(file)).toString("utf8"));
  change(json);
  await f.put(file, `${JSON.stringify(json, null, 2)}\n`);
}

export function untar(gzip) {
  const tar = gunzipSync(gzip);
  const entries = [];
  const string = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const name = string(header, 0, 100);
    assert.equal(relativePath(name), name);
    assert.equal(string(header, 156, 1), "0");
    assert.equal(string(header, 257, 6), "ustar");
    const checksum = Number.parseInt(string(header, 148, 8), 8);
    const copy = Buffer.from(header);
    copy.fill(32, 148, 156);
    assert.equal(copy.reduce((sum, byte) => sum + byte, 0), checksum);
    const size = Number.parseInt(string(header, 124, 12), 8);
    entries.push({
      path: name,
      bytes: tar.subarray(offset + 512, offset + 512 + size),
      mode: Number.parseInt(string(header, 100, 8), 8),
      uid: Number.parseInt(string(header, 108, 8), 8),
      gid: Number.parseInt(string(header, 116, 8), 8),
      mtime: Number.parseInt(string(header, 136, 12), 8),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.length - offset >= 1024);
  assert.ok(tar.subarray(offset).every((byte) => byte === 0));
  return entries;
}
