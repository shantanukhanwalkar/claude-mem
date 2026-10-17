# Maintained local claude-mem — HAR-977

Baseline: upstream v13.32.0. Maintained source release at the HAR-947 qualification baseline: 13.32.1-local.1, commit b90bbbfb0. Runtime provider: Claude CLI/OAuth; the pre-migration observer uses pinned Sonnet 4.5. Both Claude and Codex feed one shared worker on 127.0.0.1:37777. This background inference uses the Claude subscription, including when the foreground client is Codex. The `13.32.1-local.2` candidate adds compatibility, shared grounding clarification, and a Chroma launcher repair; its presence in source does not imply installation or Sonnet 5.5 activation. The deployment receipt and live health identify the installed release; see [the Sonnet 5.5 qualification](2026-10-18-sonnet55-migration.md) for the proposed model policy and deployment checks.

The current source carries the init-reply gate, malformed quota-window repair, guard-versus-refusal classification, and SDK stream-exit batch preservation over upstream v13.32.0. The earlier prohibition on model-based oversized-field condensation was not carried into this release. Oversized fields can trigger one bounded condensation call per field through the same hardened Observer helper and selected model; unusable condensation falls back to explicit truncation. Ordinary observations, summaries, and optional Telegram wrap-up formatting also use inference. Real provider limits still pause capture.

## Installation identity and updates

The durable source is /home/sk/development/tools/claude-mem on local/stable. The installed marketplace and both plugin caches must match the deployment receipt in ~/.local/state/claude-mem-maintenance/deployment.json. Run `node scripts/audit-local-install.cjs` from the source checkout. The receipt records the source commit, worker hash, version, and installed paths; drift is a nonzero failure with an actionable message.

The daily systemd timer now audits only. It does not fetch, rebase, push, install, restart, or call a model. Unattended upstream updates are disabled. Do not run the old `claude-mem-local-maintain --apply` flow. The earlier deployed-commit marker alone was insufficient evidence: upstream overwrote the installed files while it still named the old personal commit.

Adopting upstream is an explicit maintenance task:

1. Create an isolated candidate from local/stable, select a released upstream tag, and reconcile source changes. Rebuild generated files after resolving source conflicts; do not resolve bundle conflicts by blindly choosing upstream bytes.
2. Run worker, SDK, provider, audit and integration tests; run root/viewer type checks; build. Review grounding, payload bounds, quota freshness and worker resolution together.
3. Give the local patch a coherent version in package/plugin/marketplace manifests. The hook resolver prefers a normal release over a prerelease at the same numeric version: 13.32.1-local.1 outranks upstream 13.32.0, whereas 13.32.0-local.1 does not. A new compatibility release needs its own reviewed version and regenerated artifacts. Codex build metadata is only a reinstall cachebuster.
4. Back up installation metadata/settings and the current receipt; use SQLite's backup API for a consistent database snapshot if needed. This upstream baseline holds its active observation queue in RAM: the legacy SQLite pending_messages table is not that queue. Normally wait for /api/processing-status queueDepth=0 before restarting. If a broken worker cannot drain, first preserve the original Claude/Codex transcripts and identify the pending interval for controlled recovery. A SQLite backup alone does not preserve in-flight work. Preserve quota cooldowns.
5. Install the reviewed build to the marketplace and Claude cache, reinstall Codex from its confirmed local marketplace, and ensure automatic upstream updates remain disabled. Check every installed worker hash and manifest before restart.
6. Restart through the worker API. Verify the new PID/version/readiness, successful post-deployment observation capture and retrieval, and condensation only when a field exceeds its budget. Verify the served model from an assistant frame, rather than only the settings or database tag. Only then replace the deployment receipt and update HAR-977/HAR-947/provider records.

## Settings the install must carry

Upstream made the quota guard's per-window thresholds settings (#4396) and ships `CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY` at `0.93`. The local contract is a 95% weekly reserve, so the host's `~/.claude-mem/settings.json` must set `CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY=0.95` at install time, as a string or a JSON number. The source no longer overrides the default: it is configuration, read on every guard decision, and a fresh install or a settings reset silently drops back to 93%. Verify with `shouldAbortForQuota` on a 94% weekly reading (it must continue) and check the setting after every deployment, next to the receipt audit.

Preserve stricter model-specific windows too: the Sonnet weekly threshold is currently `0.92`. Preserve persisted cooldowns, queue limits, and conversation/field budgets during a model migration. The source's Claude budget remains 200,000 tokens unless explicitly overridden or selected with `[1m]`; Sonnet 5.5's advertised larger window does not authorize widening it.

## Rollback

Keep the prior reviewed source commit and deployment receipt. Restore its generated plugin bytes and matching installation manifests through the same installation procedure, then restart. Restore installation metadata from the saved backup only when paths and bytes have also been restored. Do not restore an old database over new observations or clear the queue to make health look green. The original upstream 13.24.1 cache is a diagnostic fallback and still contains the quota/condensation defects; prefer a prior verified local stable release once one exists.

## Operational checks

`GET /api/health` must report the receipt's version and one initialized worker. `/api/processing-status` describes the active RAM queue; SQLite pending_messages rows are legacy work and must not be reported as the current buffer. A successful HTTP health response alone does not prove memory capture: check a new observation row and retrieve it through search. Generic stream failures pause with buffered work retained during the process lifetime; there is no automatic retry loop. The next normal ingest may resume it.

For quota pauses compare the newest unified windows and timestamps, rather than an old isolated utilization reading. Real exhaustion requires waiting for reset; restarting is not a way to bypass it. The stale snapshot defect fixed here was different: its expired window continued to block healthy usage. Persisted cooldown state is preserved during deployment.

Code/tests and a short live canary establish the repaired behavior; they do not prove multi-day reliability or an exact subscription savings percentage. Continue checking the read-only audit and useful observation output during ordinary use.
