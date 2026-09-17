# Security policy

## Preview status and reporting

`0.1.0-preview.1` is a source preview without a versioned release. There is no promised security-support window or response SLA. Fixes should target the current preview source; older snapshots may not receive backports.

The public source repository is [formulahendry/git-workbench-copilot-canvas](https://github.com/formulahendry/git-workbench-copilot-canvas). **No private reporting channel is currently advertised or confirmed enabled.**

If the repository's **Security → Report a vulnerability** control is available, use GitHub's private vulnerability reporting flow. Its availability must be checked; this document does not assert that it is enabled. If it is unavailable, do not put exploit details in a public issue. You may ask the maintainer to establish a private reporting channel using a neutral public message that contains no sensitive details.

**Never post credentials, token-bearing canvas URLs, private repository paths, catalogs, unredacted logs, or sensitive exploit material in a public issue or pull request.** Do not send a report to a guessed email address. Revoke exposed credentials using the issuer's official controls before sharing a sanitized reproduction through an established private channel.

Once a private channel exists, useful report contents are the affected version/host/platform, impact, minimal synthetic reproduction, and suggested mitigation. Do not test against repositories or systems you do not own or have permission to assess.

## Trust boundary

Git Workbench is an extension process running with **the current user's operating-system permissions**, not an isolated sandbox. Install only reviewed extension source and open only repositories you trust.

The canvas serves local assets from a server bound to `127.0.0.1` on an ephemeral port. It checks Host, validates request Origin when supplied, requires a per-instance token for sensitive requests, and sets a restrictive Content Security Policy. These controls reduce unintended browser access; they do not protect against arbitrary software already running as your user or a compromised host.

The host-supplied Copilot SDK is resolved automatically. There are no third-party runtime dependencies to install or bundle. That does not remove the trust placed in Node, Git, the host, or extension source.

Git reads and writes use local Git and repository/user configuration. **Hooks, credential helpers, filters, signing tools, and remote transports can execute programs, use credentials, or access the network.** Read-only canvas actions mean no supported Git mutation endpoint is exposed through those actions; they do not promise that Git configuration is inert. Remote operations may send repository content to the configured destination. Review the repository and its configuration before use.

## Mutation protections and limitations

The agent-facing actions `catalog`, `context`, and `read` are read-only. Git writes use the canvas UI's **prepare → explicit confirmation → one-shot execution** flow. The command plan and repository fingerprint are revalidated; stale, expired, or already-used confirmations cannot authorize a new write.

Supported writes are limited to staging/unstaging, staged-only commits, clean-state local branch creation/switching, fetch, fast-forward-only pull, non-force existing-upstream push, and guarded stash push/apply/pop. There is no hard reset, working-file discard, force push, or automatic conflict resolution.

These protections do not make Git operations transactional or prevent an independently running process from changing the repository. A hook, network request, command timeout, or later failure may leave partial effects. **Never automatically retry writes.** Inspect and refresh local/remote state before preparing a new operation.

`refresh_failed_after_write` means the Git command completed but the subsequent refresh failed. Treat it as a completed write with an unavailable refresh, not a reason to execute the write again.

## Local data

The user-global catalog, last manual selection, and bounded per-repository UI preferences live in:

```text
$COPILOT_HOME\extensions\git-workbench\artifacts\repositories.json
```

`COPILOT_HOME` defaults to `~\.copilot`. The data is separate from the plugin cache, so plugin uninstall does not delete it. For a directly installed user extension, the artifacts directory sits alongside its source; deleting the entire extension directory also removes that data. Preserve artifacts explicitly when replacing or removing direct extension source. Paths, names, selected remotes, search/filter text, and tree state can reveal private information even though the application does not persist tokens, confirmation IDs, history refs, or drafts.

- Do not publish/share this artifact directory, user profile, installed plugin cache, or logs.
- Do not share a canvas URL: it contains a per-instance access token.
- Use only reviewed, allowlisted source bundles when distributing the extension; never recursively share a live user extension folder as a gist.
- Removing a catalog entry clears its saved preferences and any matching last-selection marker, but does not delete the repository. For targeted data clearing, stop all providers and follow the [README](README.md#manually-clear-saved-data).
- When switching installation routes, keep the artifact directory in place and explicitly remove/disable only the old source provider. An artifacts-only folder without `extension.mjs` does not load a user provider. Do not silently overwrite an installation or move/delete the full folder with its artifacts.

Read/output limits and command timeouts constrain resource usage, but do not guarantee responsiveness for every repository or Git configuration.
