# Weekly observer reserve and accurate quota warnings

Status: implemented and verified in the maintained fork; live activation pending.

## Decision

On 2026-09-29 the owner requested: "can you raise the allowance limit to 95% and update the message to reflect it properly?" The owner also explicitly confirmed that this work belongs in the forked claude-mem repository.

The approved change raises only the all-model weekly (`seven_day`) precautionary observer pause threshold from 93% to 95%. This does not increase the provider's actual allowance. The five-hour, model-specific weekly, extra-usage and reset-buffer guards retain their existing values. Real provider rejections still stop capture regardless of local thresholds.

The observer now preserves a structured quota decision through SDK shutdown and generator finalization. The health ledger and startup warning distinguish a precautionary `quota_guard` from `quota_exhausted`. Guard warnings show observed usage and the actual threshold. Ambiguous records written by the old worker remain explicitly ambiguous instead of falsely asserting provider exhaustion. Warning text correctly says the cooldown survives restarts.

## Execution record — rulings

- Authoritative repository: `/home/sk/development/tools/claude-mem`, origin `git@github.com:shantanukhanwalkar/claude-mem.git`. Candidate worktree: `/home/sk/worktrees/claude-mem-quota-95`, branch `fix/quota-95-warning`.
- The initial patch was prepared in an isolated worktree of the installed marketplace mirror. The deployment receipt identified the authoritative checkout at `1feac24d1571e96c0b6a1383ca23229ad8ac3201`; the source/test patch was reapplied there and rebuilt. This preserves the already-deployed hook stdout-drain fix that the mirror's source HEAD lacks.
- Existing installed-checkout modifications are untouched. Build dependencies were reused from the installed marketplace's existing `node_modules`, without installing or upgrading packages. An unrelated generated SQLite helper difference was excluded; only the affected worker and context-generator bundles are included.
- Review found that an early local guard could hide a provider rejection in another quota window. All active provider rejections are now checked before precautionary guards. A failing regression test reproduced the case before the fix. Legacy warning advice was also made provider-specific.
- No provider, model, observer settings, installed plugin, live health/cooldown file, or deployment receipt was changed. No worker restart, queue clear, or model smoke test was performed.
- The threshold is compiled into the worker. Activation requires the reviewed maintenance procedure in `docs/local-stable-runbook.md`, including preserving in-memory queued work, retaining cooldown state, recording the explicit maintenance decision, installing matching artifacts, and verifying actual capture. Source edits alone do not activate this change.
- Read-only pre-activation check: live worker PID 16392, version 13.24.2-local.2, health `ok`, queue depth 2774. This is a point-in-time count, not a claim that the queue is drained. The standing no-restart instruction remains in effect.

## Verification

- 147 tests passed across quota decisions, persisted health and cooldowns, SDK/finalization integration, and hook output/IO/stream discipline.
- New threshold and warning tests failed before implementation. Removing the two propagation steps made both integration controls fail; restoring them passed.
- Root and viewer TypeScript checks passed (`npm run typecheck`).
- Build passed (`node scripts/build-hooks.js`, without sync or restart).
- Independent review: no unresolved critical or important findings. The minor provider-specific legacy advice was corrected and tested.
- `git diff --check` passed.

Candidate SHA-256:

- `plugin/scripts/worker-service.cjs`: `c99b234ad8e484a52b2538473a4584b9fa08aca4b6c8032c601478832aed3aaa`
- `plugin/scripts/context-generator.cjs`: `0bee413a11e65869a8506ca4b57bfffbc892cad82e709d8846bc923ee6ae9e7a`

Example new guard reason: `Memory capture paused: weekly Claude usage is 95.0%, at or above the 95% pause threshold. This reserves allowance for interactive work.`
