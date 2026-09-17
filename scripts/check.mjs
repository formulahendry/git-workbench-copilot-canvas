import { spawnSync } from "node:child_process";
import { NAME, RUNTIME_FILES, TOOL_FILES, readSafe, safePath, reportFailure } from "./lib.mjs";

try {
  const files = [
    ...RUNTIME_FILES.filter((file) => /\.(mjs|js)$/.test(file)).map((file) => `extensions/${NAME}/${file}`),
    `extensions/${NAME}/git.test.mjs`, `extensions/${NAME}/preferences.test.mjs`, ...TOOL_FILES,
  ];
  for (const file of files) {
    await readSafe(process.cwd(), file);
    const result = spawnSync(process.execPath, ["--check", await safePath(process.cwd(), file, { kind: "file" })], { stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Syntax check failed: ${file}`);
  }
  console.log(`Syntax checked ${files.length} JavaScript files.`);
} catch (error) { reportFailure(error); }
