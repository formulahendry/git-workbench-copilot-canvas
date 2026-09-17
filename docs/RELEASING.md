# Packaging and releases

**Normal installation uses the Canvas's GitHub folder URL in the Copilot App.**
Installing the repository-root plugin is an alternative. Users do not need a GitHub
Release, a tarball, a build step, or a manual clone. See the [installation
instructions](../README.md#install). There is no automatic Release workflow.

This guide covers optional maintainer tools for downloadable archives and
immutable release pins. CI validates source and packaging; it does not publish a
Release. Creating tags, publishing releases, and updating a public marketplace
remain separate, explicitly authorized decisions.

## Local validation and optional archives

Use Node.js 22+ and Git for these maintainer commands. This Node.js requirement
does not apply to ordinary App users installing the Canvas. No dependency
installation or bundled Copilot SDK is needed:

```powershell
npm run check
npm test
npm run validate
npm run pack
```

Packing works from an uncommitted source tree. The default, ignored `dist`
directory contains:

| File | Contents |
| --- | --- |
| `git-workbench-plugin-0.1.0-preview.1.tar.gz` | `git-workbench\plugin.json`, runtime in `extensions\git-workbench`, and public docs/assets. |
| `git-workbench-canvas-0.1.0-preview.1.tar.gz` | `git-workbench\extension.mjs` and sibling runtime files, plus public docs/assets. An alternative to the plugin. |
| `integrity.json` | Archive and per-file sizes and SHA-256 hashes. |
| `SHA256SUMS` | Hashes of the two archives and `integrity.json`. |

The explicit allowlist in `scripts\lib.mjs` contains nine runtime files, seven
public text/SVG files, and the exact `assets\demo.png` binary path. The PNG is
required when README references it. No catalogs, user artifacts, logs, tests,
scripts, Git metadata, dependencies, or SDK copies are included.

The packer rejects path traversal, symlinks, junctions, and hardlinked files.
Archives use deterministic ordering, fixed timestamps of 2000-01-01, LF-normalized
text, and unchanged PNG bytes. The timestamp is not a release date. Hashes prove
byte integrity, not publisher trust.

Inspect the output before sharing:

```powershell
tar -tzf .\dist\git-workbench-plugin-0.1.0-preview.1.tar.gz
tar -tzf .\dist\git-workbench-canvas-0.1.0-preview.1.tar.gz
Get-Content -LiteralPath .\dist\SHA256SUMS
Get-FileHash -LiteralPath .\dist\git-workbench-plugin-0.1.0-preview.1.tar.gz -Algorithm SHA256
```

`npm run pack -- --out release-output` chooses another project-relative
directory; unlike `dist`, that directory is not automatically ignored.

To inspect an archive installation, extract it and use its inner `git-workbench`
directory, not the `.tar.gz` itself. Use an isolated Copilot home and synthetic
repository for installation or write tests. Never recursively copy/share an
installed user extension: its artifacts can contain private data. Keep existing
user data intact and load only one provider; see [Security](../SECURITY.md#local-data).

## Optional versioned releases

The current marketplace entry uses `"source": "./"` and installs source from the
default branch. A release pin is optional, not a prerequisite for this route.

If maintainers choose to publish a versioned release:

1. Align `plugin.json`, `package.json`, the marketplace's `metadata.version` and plugin entry `version`, and the changelog.
2. Review the source and archives for private data. Obtain authorization before committing, tagging, pushing, or publishing.
3. Create the approved `v<version>` tag on the reviewed commit, then verify the clean tagged checkout.
4. Publish the reviewed GitHub Release manually, marking preview versions as prereleases. No checked-in workflow does this automatically.
5. Optionally pin the default-branch marketplace to that published release using its actual tag and full commit SHA.

Once an authorized tag exists:

```powershell
$version = "0.1.0-preview.1"
$tag = "v$version"
$releaseSha = (git --no-pager rev-parse --verify "refs/tags/$($tag)^{commit}").Trim()
npm run release:verify -- --tag $tag --expected-sha $releaseSha
```

`release:verify` requires aligned versions, a clean committed checkout, and a tag
that targets `HEAD`. It does not create a tag or contact GitHub.

After the non-draft release is actually published, run in the intended
default-branch checkout with matching version metadata:

```powershell
npm run marketplace:pin -- --version $version --tag $tag --sha $releaseSha
npm run validate
git --no-pager diff -- .github\plugin\marketplace.json
```

The pin tool makes read-only GitHub API checks for the published release,
prerelease status, tag commit, and root plugin manifest. It writes only the local
marketplace's `source.ref` and full `source.sha` GitHub source entry. It never
commits, pushes, or publishes. An existing `GH_TOKEN` or `GITHUB_TOKEN` can
authenticate these requests; do not put tokens in source or command arguments.

A release commit cannot contain its own final SHA. Publish the release first,
then review and separately authorize the default-branch catalog update. Do not
move the release tag to include that update. For later versions, keep the previous
public pin until the new release exists, then update version metadata and the pin
together.

External listings are optional and separate. For `github/awesome-copilot`, follow
its current external-listing issue form; do not submit a PR editing
`plugins/external.json`, and do not claim listing acceptance before it happens.
