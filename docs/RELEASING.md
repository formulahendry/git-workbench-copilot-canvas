# Releasing Git Workbench

This is a maintainer procedure, **not a record of a versioned release**. The public source repository is `https://github.com/formulahendry/git-workbench-copilot-canvas`. No tag, GitHub Release, release-pinned marketplace entry, remote installation, App smoke test, or external listing is implied by publishing the source.

Current version: **`0.1.0-preview.1`**. Expected eventual tag: **`v0.1.0-preview.1`**. There is no release SHA until an actual reviewed commit is selected.

## Boundaries and identities

- Product: **Git Workbench**.
- Plugin name, canvas ID, and extension directory: **`git-workbench`**.
- Marketplace registration name: **`git-workbench-marketplace`**.
- License: **MIT**, copyright **2026 formulahendry**.
- Runtime: Node.js **22+**, modern Git, and a compatible Copilot App preview.
- Root `plugin.json` uses the **legacy** `"extensions": "extensions"` field. Do not add an Agent Plugins 1.0 `$schema`: its `extensions` field is not a directory selector.
- The host resolves the Copilot SDK. No third-party runtime dependency or bundled SDK is part of a release.

Local checks and packaging do not authorize repository creation, remote changes, commits, tags, pushes, release publication, global extension installation, or extension reload. Each externally visible or user-profile-changing step needs an intentional maintainer decision.

## 1. Review the source and align versions

Review the complete public source and any Git history intended for publication. Remove private names/emails, real repository/worktree paths, logs, credentials, session artifacts, installed extension state, and screenshots containing private data. If a secret was exposed, revoke it; removing a file is not sufficient.

Keep these versions aligned:

- `plugin.json`: `version`
- `package.json`: `version`
- `.github\plugin\marketplace.json`: `metadata.version` and plugin entry `version`
- `CHANGELOG.md` and the public preview/version guidance

Before the first release, the marketplace entry is local:

```json
{
  "name": "git-workbench",
  "source": "./",
  "version": "0.1.0-preview.1"
}
```

This is an excerpt, not a replacement for the full entry. `source` is relative to the repository root, **not** `.github\plugin`. The local entry allows checkout-based use before a versioned release exists.

For a later version bump, the previous release's pinned `ref` cannot describe the new plugin version. Prepare that release in a separate release checkout/branch with a reviewed local relative entry again. Keep the public default-branch catalog on the previous published pin until the new release exists. Then bring the new version metadata and its verified pin to the default branch together; do not temporarily publish an unpinned replacement catalog.

## 2. Run local checks and build distributions

From the repository root in PowerShell:

```powershell
npm run check
npm test
npm run validate
npm run pack
```

These use existing Node tooling with no dependency installation. `npm run test:packaging` is the targeted packaging test command. An alternate project-relative output directory is supported:

```powershell
npm run pack -- --out release-output
```

Only the default `dist` output is ignored by the repository's existing ignore rules. An alternate output directory is not automatically ignored; keep it out of commits and account for it before clean-checkout release verification.

Packing is local and deterministic for the same allowlisted source bytes. Archives normalize text from CRLF to LF, preserve PNG bytes unchanged, and use fixed metadata/timestamps; the fixed archive timestamp is **not** a release date.

The default `dist` output contains:

| File | Purpose |
| --- | --- |
| `git-workbench-plugin-0.1.0-preview.1.tar.gz` | Installable plugin directory: `git-workbench\plugin.json`, runtime under `git-workbench\extensions\git-workbench`, and public docs/assets. |
| `git-workbench-canvas-0.1.0-preview.1.tar.gz` | Standalone extension directory: `git-workbench\extension.mjs` and its sibling runtime files, plus public docs/assets. No plugin manifest. |
| `integrity.json` | Archive sizes, SHA-256 hashes, and per-file inventory/hashes. |
| `SHA256SUMS` | SHA-256 hashes for the two archives and `integrity.json`. |

The distribution allowlist includes the nine runtime files (`extension.mjs`, `context.mjs`, `git.mjs`, `server.mjs`, `store.mjs`, `preferences.mjs`, `app.js`, `index.html`, `styles.css`) and seven required public files (`LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `docs\RELEASING.md`, `assets\preview.svg`). A separate, exact binary allowlist includes `assets\demo.png` when present; it is included in this preview, giving both bundles eight public files. The README references this PNG, so do not remove it without updating the documentation. No other image or asset directory is copied recursively.

The plugin bundle additionally includes `plugin.json` and retains the plugin directory layout. The standalone bundle places runtime files at its extension directory root.

Development tests, scripts, workflows, `package.json`, marketplace metadata, `.git`, dependency folders, catalogs, logs, and artifact directories are **not runtime bundle inputs**. Review changes to the explicit allowlist when adding source files. The packer rejects unsafe paths/symlinks/junctions; do not work around those checks by recursively copying a live installation.

Inspect the archive listings and checksum files before distribution:

```powershell
tar -tzf .\dist\git-workbench-plugin-0.1.0-preview.1.tar.gz
tar -tzf .\dist\git-workbench-canvas-0.1.0-preview.1.tar.gz
Get-Content -LiteralPath .\dist\SHA256SUMS
Get-FileHash -LiteralPath .\dist\git-workbench-plugin-0.1.0-preview.1.tar.gz -Algorithm SHA256
Get-FileHash -LiteralPath .\dist\git-workbench-canvas-0.1.0-preview.1.tar.gz -Algorithm SHA256
Get-FileHash -LiteralPath .\dist\integrity.json -Algorithm SHA256
```

Compare the displayed hashes with `SHA256SUMS`; the manifest does not verify itself merely by being present. Hashes establish byte integrity, not the trustworthiness of source or publisher.

## 3. Verify installation and App behavior deliberately

Unpack a reviewed plugin bundle into a new project-local inspection directory and install its inner `git-workbench` directory only when an installation test is authorized. Alternatively, use the local source/marketplace route in the [README](../README.md#install-from-a-local-checkout). Do not install a `.tar.gz` directly with `copilot plugin install`; the documented local specification is a directory.

The standalone archive is an **alternative** to the plugin, not an additional required component. If a user explicitly chooses manual extension installation, copy its reviewed runtime source into a single supported discovery directory named `git-workbench`, without overwriting existing source or artifacts. Do not install the plugin and standalone provider together. Follow the [migration procedure](../README.md#migrate-an-existing-user-extension) for an existing user installation.

Never share an installed user extension recursively or gist-share a state directory. Artifact data remains under `$COPILOT_HOME\extensions\git-workbench\artifacts`, independent of either distribution and the plugin cache.

Use a disposable synthetic repository for write tests. Record the actual App build, platform, installation route, and checks performed: worktree selection, non-switching open, tree/diff/history reads, preference persistence, confirmation cancellation/staleness, and deliberate supported writes. A CLI plugin listing, a browser harness, or the synthetic SVG is not an App host smoke test.

Windows is the primary validation target. The optional Linux packaging CI job is only a packaging smoke test; it does not establish full Linux/App support.

## 4. Create the version tag only when authorized

The public source repository already exists. Tagging a release commit is a separate publication decision: a maintainer must explicitly approve the selected reviewed commit and version tag. Source publication and a successful local package build do not authorize creating tags or releases.

Once a real version tag has intentionally been created on the reviewed commit, verify the clean tagged checkout:

```powershell
$version = "0.1.0-preview.1"
$tag = "v$version"
$releaseSha = (git --no-pager rev-parse --verify HEAD).Trim()
npm run validate -- --version $version --tag $tag
npm run release:verify -- --tag $tag --expected-sha $releaseSha
```

`release:verify` requires:

- Matching plugin, package, and marketplace versions.
- A tag exactly equal to `v<version>`.
- The tag's commit to equal the actual checked-out `HEAD`.
- A full, nonzero 40-character commit SHA; a supplied expected SHA must match.
- A clean committed checkout.

It does not create tags or contact GitHub. A dirty preparation workspace without a real release tag is expected to fail this check; do not fabricate a tag/SHA just to obtain a green result.

## 5. Prepare and review a draft GitHub release

The checked-in release workflow is restricted to the intended repository. It runs after an authorized version-tag push, or through manual dispatch with an **existing tag** and the explicit `create-draft` confirmation.

Its verification job checks tag/version/commit identity, tests and packages the code on Windows, and uploads build artifacts with read-only repository permissions. Only the draft-creation job has `contents: write`; it verifies checksums and rechecks the remote tag before creating a **draft** release. Preview versions are marked as prereleases.

This workflow does **not** publish a public release, create a missing version tag, or pin the marketplace. Review the existing draft if a run fails after creating it; do not blindly repeat a write-producing release step.

Before deliberately publishing the draft:

1. Confirm the tag resolves to the reviewed commit and the release version matches all metadata.
2. Review both allowlisted archives, `integrity.json`, and `SHA256SUMS`; exclude unrelated assets.
3. Review the changelog/release notes and disclose untested host/platform cases.
4. Keep **prerelease** enabled for `0.1.0-preview.1`.
5. Confirm public security-reporting options actually available on the repository. Do not claim private vulnerability reporting is enabled unless it is.

Publishing the reviewed draft is a separate, explicit maintainer action.

## 6. Pin the default-branch marketplace after publication

A catalog committed inside a release cannot contain its own eventual commit hash. Resolve this with two separate steps: publish the reviewed release first, then update the **default branch's marketplace catalog** to point back to that immutable release commit.

After the non-draft release really exists, use the actual tag/SHA from the published release. In the checked-out repository with that tag available:

```powershell
$version = "0.1.0-preview.1"
$tag = "v$version"
$releaseSha = (git --no-pager rev-parse --verify "refs/tags/$($tag)^{commit}").Trim()
npm run marketplace:pin -- --version $version --tag $tag --sha $releaseSha
npm run validate
git --no-pager diff -- .github\plugin\marketplace.json
```

Run the pin command in the intended **default-branch checkout**, whose version metadata must still match the released version. It performs read-only GitHub API checks: the release must be published/non-draft, prerelease status must match the version, the tag must resolve to the supplied full SHA, and the `plugin.json` at that exact commit must match.

An already configured `GH_TOKEN` or `GITHUB_TOKEN` can authenticate those checks when needed; never put tokens in command arguments, files, logs, or release notes.

On successful verification, the script changes only the local marketplace catalog, setting:

- `source.source` to `github`
- `source.repo` to `formulahendry/git-workbench-copilot-canvas`
- `source.ref` to the actual release tag
- `source.sha` to the verified full 40-character commit SHA

The script refuses guessed/mismatched identities and does not commit, push, create a release, or publish the catalog. Review the diff, then obtain explicit authorization for the separate default-branch commit/push. **Do not move or rewrite the release tag** to include this follow-up catalog commit.

After publication is genuinely complete, update the default-branch README/changelog status to match reality. Users can then add the future remote marketplace and refresh/update with:

```powershell
copilot plugin marketplace add formulahendry/git-workbench-copilot-canvas
copilot plugin install git-workbench@git-workbench-marketplace
```

For an already registered remote marketplace:

```powershell
copilot plugin marketplace update git-workbench-marketplace
copilot plugin update git-workbench
```

The GitHub CLI plugin reference supports `source.ref` together with a full `source.sha`; the SHA prevents tag movement from silently changing a pinned installation. Keep the marketplace registration on the default branch so it can advertise new reviewed release pins. Pinning the marketplace repository itself to an old tag would freeze its catalog.

If replacing a local registration of `git-workbench-marketplace` with the remote one, explicitly uninstall its plugin and remove the old marketplace first; the registration name is the same. Preserve the independent user artifacts.

## 7. External discovery comes last

Only after the source, release assets, README installation steps, and marketplace pin are public and verified should a maintainer propose an external listing.

For `github/awesome-copilot`, check the repository's current contribution guidance and submit the applicable **external listing issue form**. Do **not** open a pull request editing `plugins/external.json`. Listing submission and acceptance are separate from publishing this repository; never advertise acceptance before it happens.

## References

- [GitHub Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- [Finding and installing plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)
- [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)
