import {
  MARKETPLACE, NAME, REPOSITORY, validateProject, validateReleaseIdentity,
  requireCondition, readSafe, writeSafe, jsonBytes, isMain, options, reportFailure,
} from "./lib.mjs";

export async function githubJson(endpoint) {
  requireCondition(endpoint.startsWith(`/repos/${REPOSITORY}/`) && !endpoint.includes(".."), "Unexpected GitHub API endpoint.");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "git-workbench-release-tooling",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  requireCondition(response.ok, `GitHub verification failed (${response.status}); no marketplace changes were made.`);
  return response.json();
}

export async function verifyPublishedRelease(identity, request = githubJson) {
  const { version, tag, sha } = validateReleaseIdentity(identity.version, identity.tag, identity.sha);
  const prefix = `/repos/${REPOSITORY}`;
  const release = await request(`${prefix}/releases/tags/${encodeURIComponent(tag)}`);
  requireCondition(release.tag_name === tag && release.draft === false && typeof release.published_at === "string" && Number.isFinite(Date.parse(release.published_at)), "The supplied tag must have an actual published, non-draft GitHub release.");
  requireCondition(release.prerelease === version.split("+")[0].includes("-"), "Published release prerelease status must agree with the semantic version.");
  const commit = await request(`${prefix}/commits/${encodeURIComponent(tag)}`);
  requireCondition(commit.sha?.toLowerCase() === sha, "Published tag does not resolve to the supplied commit SHA.");
  const remoteFile = await request(`${prefix}/contents/plugin.json?ref=${sha}`);
  requireCondition(remoteFile.type === "file" && remoteFile.encoding === "base64" && typeof remoteFile.content === "string", "Published commit must contain a root plugin.json.");
  const remotePlugin = JSON.parse(Buffer.from(remoteFile.content, "base64").toString("utf8"));
  requireCondition(remotePlugin.name === NAME && remotePlugin.version === version && remotePlugin.extensions === "extensions" && !("$schema" in remotePlugin), "Published plugin manifest does not match the requested version and legacy layout.");
  return { version, tag, sha };
}

export async function pinMarketplace({ root = process.cwd(), version, tag, sha, request = githubJson }) {
  const identity = validateReleaseIdentity(version, tag, sha);
  const before = await readSafe(root, MARKETPLACE);
  const project = await validateProject(root);
  requireCondition(project.version === identity.version, "Supplied version must match plugin.json, package.json, and marketplace.json.");
  await verifyPublishedRelease(identity, request);
  requireCondition(before.equals(await readSafe(root, MARKETPLACE)), "Marketplace changed during verification; refusing to overwrite.");
  const current = await validateProject(root);
  requireCondition(current.version === identity.version, "Project version changed during verification.");
  requireCondition(before.equals(await readSafe(root, MARKETPLACE)), "Marketplace changed during verification; refusing to overwrite.");
  project.marketplace.metadata.description = "Git Workbench for GitHub Copilot, pinned to a published release commit.";
  project.marketplace.plugins[0].source = {
    source: "github",
    repo: REPOSITORY,
    ref: identity.tag,
    sha: identity.sha,
  };
  await writeSafe(root, MARKETPLACE, jsonBytes(project.marketplace));
  return identity;
}

if (isMain(import.meta.url)) {
  try {
    const result = await pinMarketplace(options(process.argv.slice(2), ["version", "tag", "sha"]));
    console.log(`Pinned the local marketplace to published ${result.tag} at ${result.sha}. Review and commit this change separately.`);
  } catch (error) { reportFailure(error); }
}
