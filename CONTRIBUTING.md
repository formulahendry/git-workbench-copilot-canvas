# Contributing to Git Workbench

Git Workbench is a Windows-first preview canvas for the GitHub Copilot App. The public source repository is [formulahendry/git-workbench-copilot-canvas](https://github.com/formulahendry/git-workbench-copilot-canvas). A versioned release has not yet been published.

## Before making changes

- For a bug, describe expected versus actual behavior, the App/CLI/Git/Node versions, platform, and minimal reproduction using synthetic data.
- Discuss significant feature or architecture changes before implementation.
- For vulnerabilities or sensitive logs, follow [SECURITY.md](SECURITY.md), not a public issue.
- Do not include private repository names, paths, author identities, credentials, tokens, catalogs, or real customer data in fixtures, screenshots, or reports.

## Local setup

For development, use Node.js **22+**, modern Git, and a compatible Copilot App preview with Canvas support (plus plugin support when exercising that installation route). Node.js 22 is the development/CI baseline declared in the private root `package.json`; App users do not need a separate Node.js installation to use the Canvas. This repository uses ES modules and Node's built-in tools. There are no third-party runtime dependencies and no `npm install` step.

Clone only when developing or inspecting the source:

```powershell
git clone https://github.com/formulahendry/git-workbench-copilot-canvas.git
Set-Location git-workbench-copilot-canvas
$checkout = (Get-Location).Path
copilot --plugin-dir $checkout plugin list
```

For an intentional local App installation, register `$checkout` with `copilot plugin marketplace add $checkout`, then install `git-workbench@git-workbench-marketplace`. Use a separate Copilot home when testing so an existing installation is not replaced. Local directory marketplace sources load live from the checkout on restart/new session; keep the checkout in place. Ordinary users can [install directly from GitHub](README.md#install) without cloning.

The extension entry point is `extensions\git-workbench\extension.mjs`. The host automatically resolves `@github/copilot-sdk/extension`; never add or bundle that SDK. Do not change the stable `git-workbench` plugin/canvas/folder identity without an explicit migration design.

Read the SDK's bundled extension/canvas documentation for your installed host before changing runtime wiring. Preserve the legacy root `plugin.json` with `"extensions": "extensions"`; an Agent Plugins 1.0 schema changes that field's semantics.

## Validate a change

Run the smallest relevant existing checks during development:

```powershell
npm run check
node --test .\extensions\git-workbench\git.test.mjs .\extensions\git-workbench\preferences.test.mjs
```

For packaging changes:

```powershell
npm run test:packaging
npm run validate
npm run pack
```

Before proposing a complete change, run `npm test` and the relevant validation/package checks. Keep test repositories and artifacts inside the harness's isolated temporary directories (OS temporary storage or ignored project-local fixtures); do not point write tests at a real working repository. Tests are not proof of successful App rendering or remote installation.

### Optional browser-renderer smoke test

If a compatible Chromium executable is already installed, the built-in-only browser harness can exercise the actual renderer without installing browser automation dependencies:

```powershell
$chromium = "C:\path\to\chromium.exe"
node .\tests\browser-smoke.mjs $chromium
```

Replace the example with the absolute path to your installed executable. This is an optional manual check, not a requirement of the Node CI suite. The harness uses a synthetic repository under the checkout's `.tmp` directory, an isolated browser profile/catalog, and local loopback servers. It checks renderer behavior including split diffs, history, and preference persistence across a new port.

An optional second argument specifies a screenshot output path. Keep any screenshot in private local/session artifacts for inspection; do not commit it or replace the public illustration without a separate privacy review. This harness does **not** exercise SDK discovery or the Copilot App host, and a successful run must not be described as a host integration test.

### App host smoke test

For an intentional App smoke test, use the [installation instructions](README.md#install), install only one provider, and use a disposable repository. Check:

1. Open from a session worktree and with an explicit repository path; neither should switch branches.
2. Browse SCM trees, diff modes, history, blame, and refs.
3. Verify UI preferences survive a fresh panel/session and remain repository-scoped.
4. Verify read-only `catalog`, `context`, and `read` actions do not expose writes.
5. Preview a mutation, cancel it, then prepare and explicitly confirm a fresh mutation.
6. Verify stale/expired confirmations cannot execute and write failures are never automatically retried.

Record what was actually tested, including host build and any unsupported cases. Do not label a synthetic preview image as a screenshot.

## Design constraints

- All Git writes stay behind **UI prepare → explicit confirm → one-shot execute**, with a staleness fingerprint. The agent-facing action catalog stays read-only.
- Preserve staged-only commits, clean-state branch switching, fast-forward-only pull, and non-force existing-upstream push. Do not silently add destructive operations.
- Treat repository text as untrusted display content; maintain loopback binding, Host/Origin/token checks, restrictive CSP, bounded inputs/output, and no secret logging.
- A write may partially succeed before failure. Keep `refresh_failed_after_write` distinct from an operation failure and never retry a write automatically.
- Persistent data belongs under `$COPILOT_HOME\extensions\git-workbench\artifacts`, independently of installation/cache paths. Preserve catalogs and restrict persisted UI fields; do not save tokens, confirmation capabilities, refs, or drafts.
- Read the [security trust model](SECURITY.md). The extension runs with user privileges; confirmation is not a sandbox for hooks, credential helpers, filters, or remote effects.
- Keep distribution inputs explicitly allowlisted. Never recursively package a live extension/state directory, user profile, or repository.

## Submitting a contribution

Use a focused branch and pull request. Explain the problem, implementation, tests actually run, and any compatibility or migration impact. Include synthetic fixtures where behavior needs regression coverage. Update related public docs and the changelog without claiming an unreleased version is published.

Contributions must be your own work or appropriately licensed, compatible with this repository's [MIT license](LICENSE). Do not copy product logos, screenshots, or third-party UI assets without permission. The preview illustration is original synthetic artwork.

Release preparation is separate from publishing: see [docs/RELEASING.md](docs/RELEASING.md). A contribution does not authorize changing global installations, creating remotes/tags, or publishing packages/releases.
