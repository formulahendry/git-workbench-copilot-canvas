# Git Workbench — A Canvas for the GitHub Copilot App

**Git Workbench** brings repository trees, diffs, history, and deliberately confirmed Git operations into a visual canvas beside your Copilot conversation.

**Preview: `0.1.0-preview.1` · Windows-first · MIT**

The source preview is available at [formulahendry/git-workbench-copilot-canvas](https://github.com/formulahendry/git-workbench-copilot-canvas). A versioned GitHub Release and release-pinned marketplace entry have not yet been published, and App-host integration is not certified. Use the checkout-based installation routes below.

![Standalone Git Workbench browser rendering showing the synthetic aurora-demo repository and a split source diff](assets/demo.png)

*Standalone browser rendering with synthetic demo data; not the Copilot App chrome.*

[View the original concept illustration](assets/preview.svg). *Illustration — synthetic demo data, not a screenshot.*

## What you can do

- Browse a multi-repository SCM tree with **staged changes, working changes, and conflicts**.
- Inspect **unified, split, and raw diffs**.
- Explore paginated commit history and its parent graph.
- Browse **local branches, remote branches, tags, remotes, stashes, and worktrees**.
- Read blame and file history, inspect commits, and compare refs without checking them out.
- Stage and unstage changes; commit the index; create or switch local branches; fetch, fast-forward-only pull, push to an existing upstream, and push/apply/pop stashes.

The agent-facing canvas actions are **`catalog`, `context`, and `read` only**. Git mutations are available through the canvas UI, not agent actions.

## Requirements

- **GitHub Copilot App preview with Canvas rendering and plugin-contributed extension support enabled.** Availability depends on your build and account. Plugin installation in the terminal-only Copilot CLI does **not** supply the visual renderer.
- **Node.js 22 or newer**, available to the host, and a modern **Git** on `PATH` with `git switch`, `git restore`, worktree support, and porcelain v2 status.
- **Windows first.** Other platforms are not fully supported or validated by this preview.
- A local Git working tree you trust, plus your own Git identity, credentials, and upstream configuration where needed.

The extension uses Node ES modules and has no third-party runtime dependencies. Copilot resolves `@github/copilot-sdk/extension` from the host automatically: **do not install or bundle the SDK**. The root `package.json` is private development/release tooling, not an npm distribution.

## Install from a local checkout

Choose **one** installation route. Do not load the plugin and a standalone copy of the same canvas at the same time. If you already have a user-scope extension, read [migration](#migrate-an-existing-user-extension) first.

Commands below use PowerShell from the root of this checkout. They change your Copilot plugin configuration only when **you** run them. Check the available commands with `copilot plugin --help`, and ensure the CLI and App use the same intended Copilot home/profile.

To obtain a checkout first:

```powershell
git clone https://github.com/formulahendry/git-workbench-copilot-canvas.git
Set-Location git-workbench-copilot-canvas
```

### Option A: install the plugin directly

Use the absolute checkout path; some CLI builds reject a bare `.` install specification. Direct installs are deprecated in Copilot CLI 1.0.80-1, so prefer the marketplace route below for ongoing use.

```powershell
$checkout = (Get-Location).Path
copilot plugin install $checkout
copilot plugin list
```

The checkout has a legacy root `plugin.json` with `"extensions": "extensions"` and the implementation in `extensions\git-workbench`. This is deliberately not an Agent Plugins 1.0 manifest: that format gives the `extensions` field a different meaning.

After installation, start a new App session or use the restart mechanism supported by your preview build. Check that Git Workbench is enabled and that the session has Canvas support. A successful CLI install alone does not verify App rendering.

### Option B: register the local marketplace

```powershell
$checkout = (Get-Location).Path
copilot plugin marketplace add $checkout
copilot plugin marketplace list
copilot plugin marketplace browse git-workbench-marketplace
copilot plugin install git-workbench@git-workbench-marketplace
copilot plugin list
```

The catalog is `.github\plugin\marketplace.json`, its registration name is **`git-workbench-marketplace`**, and its current relative source points to this checkout's root. According to the CLI reference, path-sourced plugins in a local directory marketplace load live from their source directory: keep that checkout in place and restart or begin a new session after editing it. A plugin update is not needed for those live file edits.

### App: Customize → Plugins

If your App preview exposes **Customize → Plugins** and an **add custom marketplace** control, add the local checkout directory where local sources are supported, find `git-workbench` in `git-workbench-marketplace`, and install/enable it. Labels and accepted source types can differ between preview builds. If the control accepts only a GitHub repository, the release-pinned route below remains pending; use the CLI checkout-based route for this source preview. The public source catalog is still a development catalog, not an immutable release pin.

If your build lacks custom marketplaces or Canvas/plugin extension support, use a compatible preview build rather than expecting a terminal session to render a canvas.

### Release-pinned remote installation — pending

Only after a versioned release and its pinned marketplace entry have been published:

```powershell
copilot plugin marketplace add formulahendry/git-workbench-copilot-canvas
copilot plugin marketplace browse git-workbench-marketplace
copilot plugin install git-workbench@git-workbench-marketplace
```

The proposed marketplace entry will pin both the release tag in `source.ref` and its **full 40-character commit SHA** in `source.sha`. No release SHA is assigned in this documentation. See [Releasing](docs/RELEASING.md) for the publish-then-pin sequence. Direct repository installation, if used after publication, follows the repository's selected source rather than that marketplace pin.

### Update, disable, or uninstall

For a directly installed plugin, update its source first as appropriate, then:

```powershell
copilot plugin update git-workbench
```

For a published marketplace installation, refresh the catalog **and** update the plugin:

```powershell
copilot plugin marketplace update git-workbench-marketplace
copilot plugin update git-workbench
```

For the current local relative marketplace entry, source file edits instead take effect on restart/new session. Refresh the marketplace when its catalog changes. If the source has been changed to a pinned remote entry, it is no longer the local live-source route.

To disable or re-enable without uninstalling, use your App build's plugin controls when available. CLI command availability varies: Copilot CLI 1.0.80-1 does not advertise `plugin disable` or `plugin enable`, so do not assume those commands exist.

To remove the plugin and, if you registered it, its marketplace:

```powershell
copilot plugin uninstall git-workbench
copilot plugin marketplace remove git-workbench-marketplace
```

Uninstall before removing the marketplace; normal marketplace removal refuses while its plugins remain installed. These operations do not intentionally clear Git Workbench's separate artifact data. Restart the App/session as needed to stop an already running provider. See [local data](#local-data-and-privacy) before manually deleting anything.

## Open Git Workbench

In a compatible App session, ask:

> Open Git Workbench for this repository

Or provide an explicit local repository path:

> Open Git Workbench for `C:\src\aurora-demo`.

The stable plugin name, canvas ID, and extension folder name are all **`git-workbench`**. The canvas open input accepts `repoPath`; an optional `repositories` array registers additional repository roots.

Initial selection follows this order:

1. An explicit **`repoPath`**.
2. The session context's **`workingDirectory`**, resolved to its actual Git working tree, including a linked worktree.
3. The **last manually selected repository**, when there is no repository in the session context.
4. No selection, if none of those applies.

It does not substitute a project's main checkout for the session's worktree. Selecting a repository or reopening the canvas defaults history to **`HEAD`**; `historyRef` is never restored from saved preferences. Opening the canvas, choosing a repository, or viewing a branch/ref does **not** switch the Git checkout.

## Git operations: preview before execution

Every UI mutation follows **prepare → explicit confirmation → one-shot execution**. The preview shows the target and commands. A repository fingerprint is rechecked before execution; a changed repository requires a fresh preview and confirmation. Confirmations expire and cannot be reused.

| Operation | Scope and guardrails |
| --- | --- |
| Stage / unstage | Selected paths, or all where offered. Unstaging preserves working files. |
| Commit | **All staged changes only**; unstaged and untracked content is not automatically added. Conflicts and in-progress Git operations must be resolved first. |
| Create / switch branch | Creates and switches to a new local branch, or switches to an existing local branch. Requires a clean working tree and no in-progress operation. |
| Fetch | A configured remote; no automatic merge or pruning. |
| Pull | Existing upstream on a local branch, clean state, **fast-forward only**, no rebase. Divergence is refused. |
| Push | Existing upstream on a local branch; **non-force**, one upstream branch, no automatic tag publishing. Configure the upstream outside the canvas first. |
| Stash push | Eligible tracked changes, optionally untracked files; no conflicts/in-progress operation. |
| Stash apply / pop | Existing stash and a clean working tree; conflicts may still need manual resolution. Pop only drops the stash if Git applies it successfully. |

There is no hard reset, working-file discard, force push, or automatic conflict resolution. A read-only agent action is not a permission boundary for other independently available agent tools.

**Writes are not transactions.** Git hooks, credential helpers, configuration, remote services, and the filesystem can have effects beyond the displayed command. An error or timeout may follow a partially successful write. **Never automatically retry writes.** Refresh and inspect the repository and, for network operations, the remote before deciding whether to prepare a new operation.

`refresh_failed_after_write` specifically means the Git command completed but the follow-up refresh failed; it does **not** mean the write should be repeated.

## Local data and privacy

The renderer is served from a per-panel **`127.0.0.1` loopback** server with Host checking, Origin validation, a per-instance token, and a restrictive Content Security Policy. These are local request protections, **not a sandbox**: extensions execute with your user account's rights. Only open repositories and install extension source you trust. Git may run configured hooks, credential helpers, filters, and network commands. See [Security](SECURITY.md).

User-global data is stored outside the plugin installation/cache:

```text
$COPILOT_HOME\extensions\git-workbench\artifacts\repositories.json
```

`COPILOT_HOME` defaults to `~\.copilot`. The existing catalog format remains version 1, with an optional `preferences` object on each repository entry. It contains local repository paths/names, the last manual selection, and bounded preferences scoped to each repository:

- `tab`, `diffMode`, `autoRefresh`
- `remote`, `fileSearch`, `changeFilter`
- `expanded` tree state

Saved preferences do **not** include the history ref, canvas URL/token, confirmations, or drafts such as commit messages. Search/filter text is limited to 512 characters, the remote setting to 1,024 characters, and expanded tree state to 256 keys of at most 1,024 characters each with boolean values.

Only explicitly changed fields are persisted. Catalog locking and atomic writes merge concurrent patches to different fields; for the same field, the last completed write wins. A preference-load failure displays an error rather than silently replacing saved values with defaults.

There is **no automatic browser `localStorage` migration**. Previous loopback ports/origins cannot safely be rediscovered, so earlier origin-scoped settings are not imported. Without durable saved preferences, the new settings start from defaults and persist in the catalog as you use them.

Removing a repository from the catalog clears that entry's saved preferences and, if applicable, its last-selection marker. It does **not** delete the repository's directory, worktree, or Git history. Plugin updates/uninstall preserve the separate artifact location. Repository paths, filters, and selected remote names may still be sensitive: do not publish your catalog, logs, token-bearing URLs, or installed state directory.

### Manually clear saved data

First close Git Workbench and stop **all** App/CLI sessions that could run its provider. Optionally back up the catalog privately. To clear only this extension's saved catalog, selection, and preferences:

```powershell
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME ".copilot" }
$artifacts = Join-Path $copilotHome "extensions\git-workbench\artifacts"
$catalog = Join-Path $artifacts "repositories.json"
if (Test-Path -LiteralPath $catalog) {
  Remove-Item -LiteralPath $catalog -ErrorAction Stop
}
```

Only if every provider is stopped and a stale catalog lock remains, remove the specific `repositories.json.lock` file in that same artifact directory. Do not recursively remove `extensions`, the plugin cache, or any repository. If unsure which process owns a lock, leave it in place.

## Migrate an existing user extension

An older manual installation may have source files alongside `artifacts` in `$COPILOT_HOME\extensions\git-workbench`. A plugin plus a discovered standalone copy can cause duplicate canvas providers. Do not depend on shadowing to resolve this.

1. Stop the running Git Workbench providers and privately back up `artifacts\repositories.json` if needed.
2. **Explicitly choose** to disable the old standalone provider, or remove/move **only its source files, including `extension.mjs`**, keeping any source backup outside every extension discovery location. This is a user decision, never an automatic overwrite/migration.
3. Leave `$COPILOT_HOME\extensions\git-workbench\artifacts` and its catalog in place. The `git-workbench` folder may remain artifacts-only: without its `extension.mjs` entry point, the old user provider is not loaded. Do not rename/move/delete the entire folder, including artifacts, as part of removing source; a whole-folder backup would be a separate, explicitly authorized action.
4. Install and enable one plugin copy. Start a new compatible App session and confirm there is exactly one `git-workbench` provider.

These are manual instructions, not actions performed by this plugin or its packaging tools. Project-scope and session-scope standalone copies must also be disabled/removed from discovery if they would duplicate the plugin. Do not delete unrelated extensions. Old origin-scoped `localStorage` preferences are not migrated.

The release tooling creates **separate allowlisted plugin and standalone-extension bundles**. An advanced manual extension installation must use the reviewed standalone source, not a recursive copy/share of an installed user directory. Never package or gist-share a state directory containing artifacts, catalogs, logs, or credentials. See [Releasing](docs/RELEASING.md).

## Limitations and troubleshooting

- This is a focused Git workbench, **not a full GitLens replacement** or a complete Git client. No clone/init UI, merge/rebase/cherry-pick workflows, conflict editor, branch/tag deletion, remote editing, worktree creation/removal, hard reset, or force push is provided.
- Tree categories reflect the selected repository; some can legitimately be empty. A displayed category is not a promise of every possible operation on that category.
- Reads have size/time bounds. Normal Git command output is capped at 12 MiB, reads normally time out after 25 seconds, and write commands have a 120-second timeout. History is paginated (up to 200 commits per request); file listings are bounded (up to 2,000 entries). Large/binary content and very large repositories can exceed what the preview displays.
- If the canvas is missing, check your App build's Canvas/plugin support, plugin enablement, discovery location, and duplicate providers. Restart/new session may be required. Installation success is not a visual smoke test.
- If a repository is missing/moved, choose its actual local worktree path or remove and re-add the catalog entry. Refresh after changing Git state outside the canvas.
- For stale confirmations, refresh and prepare again. For write errors/timeouts, inspect state first; **do not automatically retry**.
- Host integration and platform compatibility must be verified in a compatible App; this documentation does not claim that remote installation, publication, or an App smoke test has happened.

## Development and references

```powershell
npm run check
npm test
npm run validate
npm run pack
```

No dependency installation is needed for these Node-based checks. See [Contributing](CONTRIBUTING.md), [Changelog](CHANGELOG.md), [Security](SECURITY.md), and [Releasing](docs/RELEASING.md).

Installation syntax and marketplace behavior follow GitHub's official references:

- [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Creating a plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- [Finding and installing plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-finding-installing)

## License

[MIT](LICENSE) — Copyright (c) 2026 formulahendry. Git Workbench is an independent project, not an official GitHub product.
