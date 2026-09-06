# Maintained local claude-mem — HAR-977

Baseline: upstream v13.24.1. Local release: 13.24.2-local.1. Runtime provider: Claude CLI/OAuth, Sonnet 4.5. Both Claude and Codex feed one shared worker on 127.0.0.1:37777. This background inference uses the Claude subscription, including when the foreground client is Codex.

The local release restores evidence grounding and explicit observation skips, ignores init-only completion claims, removes model-based oversized-field condensation, and refreshes/ expires quota windows. Tool fields retain bounded head/tail excerpts with explicit elision; omitted text must not be inferred. Actual observation/summary inference still costs usage and real provider limits still pause capture.

## Installation identity and updates

The durable source is /home/sk/development/tools/claude-mem on local/stable. The installed marketplace and both plugin caches must match the deployment receipt in ~/.local/state/claude-mem-maintenance/deployment.json. Run `node scripts/audit-local-install.cjs` from the source checkout. The receipt records the source commit, worker hash, version, and installed paths; drift is a nonzero failure with an actionable message.

The daily systemd timer now audits only. It does not fetch, rebase, push, install, restart, or call a model. Unattended upstream updates are disabled. Do not run the old `claude-mem-local-maintain --apply` flow. The earlier deployed-commit marker alone was insufficient evidence: upstream overwrote the installed files while it still named the old personal commit.

Adopting upstream is an explicit maintenance task:

1. Create an isolated candidate from local/stable, select a released upstream tag, and reconcile source changes. Rebuild generated files after resolving source conflicts; do not resolve bundle conflicts by blindly choosing upstream bytes.
2. Run worker, SDK, provider, audit and integration tests; run root/viewer type checks; build. Review grounding, payload bounds, quota freshness and worker resolution together.
3. Give the local patch a coherent version in package/plugin/marketplace manifests. The hook resolver prefers a normal release over a prerelease at the same numeric version, so the first local patch uses 13.24.2-local.1 to outrank upstream 13.24.1. Codex build metadata is only a reinstall cachebuster.
4. Back up installation metadata/settings and the current receipt; use SQLite's backup API for a consistent database snapshot if needed. Preserve pending messages and quota cooldowns.
5. Install the reviewed build to the marketplace and Claude cache, reinstall Codex from its confirmed local marketplace, and ensure automatic upstream updates remain disabled. Check every installed worker hash and manifest before restart.
6. Restart through the worker API. Verify the new PID/version/readiness, successful post-deployment observation capture and retrieval, and no new condensation calls. Only then replace the deployment receipt and update HAR-977/provider records.

## Rollback

Keep the prior reviewed source commit and deployment receipt. Restore its generated plugin bytes and matching installation manifests through the same installation procedure, then restart. Restore installation metadata from the saved backup only when paths and bytes have also been restored. Do not restore an old database over new observations or clear the queue to make health look green. The original upstream 13.24.1 cache is a diagnostic fallback and still contains the quota/condensation defects; prefer a prior verified local stable release once one exists.

## Operational checks

`GET /api/health` must report the receipt's version and one initialized worker. `/api/processing-status` describes active processing, while SQLite queue counts can include stranded/inactive session work and need separate interpretation. A successful HTTP health response alone does not prove memory capture: check a new observation row and retrieve it through search.

For quota pauses compare the newest unified windows and timestamps, rather than an old isolated utilization reading. Real exhaustion requires waiting for reset; restarting is not a way to bypass it. The stale snapshot defect fixed here was different: its expired window continued to block healthy usage. Persisted cooldown state is preserved during deployment.

Code/tests and a short live canary establish the repaired behavior; they do not prove multi-day reliability or an exact subscription savings percentage. Continue checking the read-only audit and useful observation output during ordinary use.
