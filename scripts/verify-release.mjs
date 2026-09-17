import { execFileSync } from "node:child_process";
import {
  validateProject, validateReleaseIdentity, requireCondition, isMain, options, reportFailure,
} from "./lib.mjs";

export async function verifyRelease({ root = process.cwd(), tag, "expected-sha": expectedSha, readGit }) {
  const { version } = await validateProject(root);
  const run = readGit || ((args) => execFileSync("git", ["--no-pager", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim());
  const git = (revision) => run(["rev-parse", "--verify", revision]);
  requireCondition(tag === `v${version}`, "Release tag must exactly match the manifest version.");
  const sha = git("HEAD^{commit}");
  validateReleaseIdentity(version, tag, sha);
  requireCondition(git(`refs/tags/${tag}^{commit}`) === sha, "Release tag must target the actual checked-out commit.");
  if (expectedSha) requireCondition(validateReleaseIdentity(version, tag, expectedSha).sha === sha, "Checkout commit does not match the triggering commit.");
  const dirty = run(["status", "--porcelain", "--untracked-files=normal"]);
  requireCondition(!dirty, "Release verification requires a clean, committed checkout.");
  return { version, tag, sha, prerelease: version.split("+")[0].includes("-") };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyRelease(options(process.argv.slice(2), ["tag", "expected-sha"]))));
  } catch (error) { reportFailure(error); }
}
