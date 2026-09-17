import { isMain, options, reportFailure, requireCondition, validateProject } from "./lib.mjs";

if (isMain(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2), ["version", "tag"]);
    const { version } = await validateProject(process.cwd());
    if (args.version) requireCondition(args.version === version, "Requested version does not match the manifests.");
    if (args.tag) requireCondition(args.tag === `v${version}`, "Tag does not match the manifest version.");
    console.log(`Validated Git Workbench ${version}, legacy manifest, marketplace, runtime allowlist, and public files.`);
  } catch (error) { reportFailure(error); }
}
