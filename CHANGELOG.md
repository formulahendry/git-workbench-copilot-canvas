# Changelog

## 0.1.0-preview.1 — Unreleased

Initial public source preview. This entry does not mark a version tag, GitHub Release, release-pinned marketplace entry, external marketplace listing, or verified App installation.

### Fixed

- Canonicalize repository paths before file-containment checks, including Windows short-name and directory aliases.
- Normalize temporary test fixture paths so Windows CI catalogs and assertions use the same repository identity.

### Changed

- Prioritize direct GitHub and marketplace installation without a manual clone or Release archive.
- Remove the automatic Release workflow; keep packaging and release-pinning tools optional for maintainers.
- Replace the standalone migration chapter with a troubleshooting note for existing manual installations.

### Added

- Git Workbench canvas with the stable `git-workbench` plugin/canvas/folder identity.
- Multi-repository SCM trees for staged/working changes and conflicts; unified, split, and raw diff views.
- Paginated history with parent graph; local/remote branch, tag, remote, stash, and worktree trees.
- Commit inspection, blame, file history, and ref comparison.
- UI-only preparation, explicit confirmation, one-shot execution, and repository staleness checks for supported Git writes.
- Staging/unstaging, staged-only commits, guarded local branch creation/switching, fetch, fast-forward-only pull, non-force existing-upstream push, and stash push/apply/pop.
- Read-only agent actions: `catalog`, `context`, and `read`.
- Session-aware selection: explicit repository path, then the session's actual working tree, then the last manual selection. Opening does not switch branches; repository selection defaults history to `HEAD`.
- A user-global version-1 catalog with optional bounded repository-scoped preferences outside the plugin cache. Per-field patches merge under catalog locking/atomic writes, and load failures display an error. Tokens, confirmations, history refs, and drafts are not persisted.
- Legacy plugin manifest, local marketplace catalog, and separate allowlisted plugin/standalone release tooling.
- Public contribution/security/release guidance, MIT license, an original synthetic preview illustration, and a standalone browser capture using synthetic demo data (not Copilot App chrome).

### Preview limitations

- Windows first; other platforms and host builds require further validation.
- Requires a Copilot App preview with Canvas/plugin extension support; terminal-only CLI installation does not provide the renderer.
- Read size/time limits and bounded history/file listings; not a complete Git client or GitLens replacement.
- No hard reset, working-file discard, force push, or automatic conflict resolution.
- Previous ephemeral-origin `localStorage` preferences are not migrated; history defaults to `HEAD` on selection/reopen.
- Git writes may partially succeed before an error. No automatic write retries; `refresh_failed_after_write` identifies a completed write whose refresh failed.
