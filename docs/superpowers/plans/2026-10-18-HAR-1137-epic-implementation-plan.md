# HAR-1137 Implementation Plan — retire Sonnet 4.5, preserve processing, stay close to upstream

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production claude-mem observer model (Sonnet 4.5, API retirement 2026-11-30) with a qualified supported model without losing pending work, and leave the maintained fork on upstream v14.0.1 with repeatable release, migration and upkeep checks.

**Architecture:** Three parallel tracks, each in its own worktree. Track A stacks a successor source correction on the frozen HAR-947 candidate (13.32 base), re-qualifies Sonnet 5.5 under a new bounded cohort, then cuts over through a quiet boundary. Track B gives the worker a permanent systemd owner and a proven lossless replacement procedure, then (after the upstream integration) a durable pending queue. Track C re-expresses the fork delta on top of v14.0.1 as fresh per-contract patches, qualifies the schema-67 migration on a copied database, and builds reproducible release gates. Track D adds the patch inventory, upstream checks and processing/retirement monitoring in server-setup. Every production action sits behind a named owner gate (G1–G6).

**Tech Stack:** TypeScript on Bun 1.3.10 (fork), Node 24 scripts, SQLite (`schema_versions`, `PRAGMA user_version`), systemd user units (dotfiles), Python 3 ops scripts with `--check` modes (server-setup), node-exporter textfile metrics + Grafana-provisioned alerts (Discord contact points), GitHub Actions (fork CI).

**Spec:** Jira epic HAR-1137 and children HAR-947, HAR-1103, HAR-1136, HAR-1138–HAR-1145 (descriptions as of 2026-10-18 20:40 IST). Supporting evidence: `/home/sk/.local/state/claude-mem-maintenance/har947-resume-20261018/HANDOFF.md`, `/home/sk/.local/state/claude-mem-maintenance/har947-upstream-assessment-20261018/UPSTREAM-ASSESSMENT.md`, Confluence 95354881, fork PR #4 (frozen release `3050420e`).

## Global Constraints

- Creating or executing this plan does **not** authorize model trials, quota spend, worker restarts or moves, production model/settings changes, or timer/workflow activation. Each needs its gate (G1–G6) recorded on the Jira ticket and in `~/.claude-mem/PROVIDER-STATE.md` before execution.
- Frozen release `3050420e7d7d2b2a08a6ed59e4f6ea2b24a4ee51` (source `a9461d5a`, PR #4) and every sealed trial directory under `har947-evaluation-20261018/` are never modified. Successor work stacks on top in a new branch.
- HAR-1135 stays Done. HAR-1136 completeness never blocks the canary; incorrect asserted metadata still fails factual accuracy.
- The live worker is PID 36177 (`13.32.1-local.1`, Sonnet 4.5, concurrency 2, 29 SKIP_TOOLS names, settings SHA `dc3df706…`). Nothing in this plan touches it, port 37777, `~/.claude-mem/settings.json` or `~/.claude-mem/claude-mem.db` except read-only GETs and `VACUUM INTO` copies, until G2.
- All tests run with a private `CLAUDE_MEM_DATA_DIR` and a private port; never the production data dir. Stub providers (canned XML over a local OpenAI-compatible HTTP server) replace model calls in every lifecycle test.
- Fork versions are `X.Y.Z-local.N` where `X.Y.Z` is the **next** upstream patch (so `14.0.2-local.1`, never `14.0.1-local.1`; CI's version-consistency step enforces full semver and must be re-carried onto v14).
- `local/stable` is replaced, never merged: tag the old tip `local/stable-<version>` first, then force-move. Adoption goes through `ops/local-maintenance/claude-mem-adopt-candidate.sh`, never the generic updater.
- Ops scripts are idempotent, have a `--check` mode, default `LOG_DIR` to `${XDG_STATE_HOME:-$HOME/.local/state}/<service>`, harden `PATH` (`$HOME/.local/bin` first), and are committed to their repo with a `~/.local/bin` symlink. Timer minutes must avoid `*:23` (Zulip sweep) and `04:15` (reap-orphaned-mcp).
- Commits: `HAR-<n>: Imperative subject` under 72 chars, no `Co-Authored-By`. Run `git diff --cached` before every commit.
- Required settings on any installed candidate: `CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY=0.95`, `CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE=1`, `CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off` (v14 default flips to `claude`), all 29 SKIP_TOOLS names preserved.

## Review Focus

1. **Hook spawns a second worker next to the systemd one** (plugin update, version mismatch, `start` hook): with `CLAUDE_MEM_WORKER_AUTOSTART=false` set in settings, no hook path may spawn, recycle or SIGKILL. Pinned by B1 step 6.
2. **Events arriving while intake is paused** must land in the on-disk spool and be drained exactly once by the next worker, including the retained unknown-session `session_end` entries. Pinned by B2 step 7 and B4 step 4.
3. **Old binary opens a schema-67 database** (installed 13.32.1 has no writer fence): rollback must be tested on a copy, and `title_norm_key` drift from an old writer must be repairable forward. Pinned by C3 steps 5–6.
4. **Observation output without a `basis` attribute or with ungrounded identifiers** must degrade deterministically (dropped facts counted in metadata) and never be stored as asserted fact. Pinned by A2 steps 4–9.
5. **A rebuild that silently changes the dependency closure** (no root lockfile; node_modules already drifted to SDK 0.3.252 while production inlines 0.3.291): CI must fail when the resolved SDK differs from the manifest. Pinned by C4 step 2.

---

## Tracks, worktrees and bases

| Track | Tickets | Worktree (create at start) | Branch | Base |
|---|---|---|---|---|
| A | HAR-1138 → HAR-1139 → HAR-947 | `/home/sk/worktrees/claude-mem-har1138` | `feature/HAR-1138-claim-basis` | `feature/HAR-947-sonnet55` @ `3050420e` |
| B | HAR-1140 (then HAR-1141) | fork: `/home/sk/worktrees/claude-mem-har1140`; dotfiles: `/home/sk/worktrees/dotfiles-har1140` | `feature/HAR-1140-worker-ownership` (both repos) | fork `local/stable`; dotfiles `main` (rebase on PR #64 once merged) |
| C | HAR-1103 → HAR-1142 → HAR-1143 | `/home/sk/worktrees/claude-mem-candidate-14.0` | `candidate/v14.0.1` | tag `v14.0.1` (commit `88ebc949`) |
| D | HAR-1144, HAR-1145 | `/home/sk/server-setup/.worktrees/har1144-1145` (+ fork files on `candidate/v14.0.1`) | `feature/HAR-1144-1145-upkeep-monitoring` | server-setup `main` |
| E | HAR-1136 | on `candidate/v14.0.1` after C1 | `feature/HAR-1136-metadata-coverage` | `candidate/v14.0.1` |
| plan | HAR-1137 | `/home/sk/worktrees/claude-mem-har1137` | `docs/HAR-1137-implementation-plan` | `local/stable` |

Dependency graph (ticket links, verified 2026-10-18): `1138 → 1139 → 947`; `1140 → 947`; `1140 → 1143`; `1103 → 1142 → 1143`; `1141` independent but schema-coupled to `1142`; `1144`/`1145` relate; `1136` non-blocking.

## Owner gates

| Gate | What it admits | Earliest | Evidence required first |
|---|---|---|---|
| G1 | HAR-1139 bounded cohort: ≤68 requests (30 pairs + 8 helpers), serial, no retries, est. list cost ≈ $2.3 (6 requests cost $0.199) | ~Oct 24 | A4 PR green on exact head; A5 package independently reviewed; quota snapshot ≤600 s old, weekly <92% |
| G2 | One worker replacement window: quiet boundary → stop local.1 → start `claude-mem-worker.service` on the new release | ~Nov 1–5 | B4 rehearsal receipt; B2 `--check` passes against live; VACUUM INTO backup |
| G3 | Switch profile to `sonnet55` and start the 24/48 h canary | same window as G2 | G1 cohort **accepted**; A7 packet rebound to the accepted release |
| G4 | Promote `14.0.2-local.1` to production (second window) | mid/late Nov | C3 migration evidence reviewed; C4 gates green; B4 procedure reused |
| G5 | Bounded re-qualification smoke on the v14 release (10 pairs) | before G4 | C2 complete; same rubric and harness as A5 |
| G6 | Activate timers/workflows: upstream check (D2), weekly proposal (D3), observer probe (D4) | after each tool's `--check` passes | tested in isolation, non-colliding schedule |

**Decision point D1 (owner):** if the G1 cohort is rejected again, choose between (a) one more source round under HAR-1138 or (b) an alternative supported model on the same CLI/OAuth route (`claude-haiku-5-5` or an Opus 4.x/5.x tier; Haiku 4.5 is past its retirement floor of 2026-10-15 and is not a candidate). The plan does not pre-decide this.

## Timeline (planning target, not a commitment)

| Week | Track A | Track B | Track C | Track D |
|---|---|---|---|---|
| Oct 19–25 | A1–A4 | B1, B2 | C1 (i–iv, vi–viii) | D1 |
| Oct 26–Nov 1 | A5 → **G1** → A6 | B3, B4 | C1 (v), C2 | D2, D4 |
| Nov 2–8 | A7, A8 (**G2/G3**), canary | — | C3 | D5, D3 |
| Nov 9–15 | canary decision, HAR-947 close | — | C4, **G5** | D6 |
| Nov 16–27 | buffer / D1 fallback | B5 (HAR-1141 on v14 base) | **G4** | **G6**, E1 |

Hard stop: 2026-11-30 (API retirement). The CLI/OAuth route's behaviour after that date is unverified; D6 defines the independent check.

---

## Track A — retire Sonnet 4.5

### Task A1: Failure taxonomy and synthetic fixture corpus (HAR-1138)

**Files:**
- Create: `docs/2026-10-20-HAR-1138-unsupported-claims.md`
- Create: `tests/fixtures/worker/claim-basis/cases.json`
- Create: `tests/fixtures/worker/claim-basis/README.md`

**Interfaces:**
- Produces: `cases.json` as an array of `{ id, kind, evidence: { tool_name, tool_input, tool_response }, model_reply_xml, expected: { storedFacts: string[], droppedFacts: number, ungroundedTokens: string[], narrativeRewritten: boolean } }`. Kinds: `comment-vs-branch`, `partial-source-vs-consumer`, `failed-native-op`, `readback-only`, `shown-mechanism`, `stated-intent`, `inferred-consequence`, `missing-basis`.

- [ ] **Step 1: Write the taxonomy doc** from the sealed adjudications (`evidence-contract-v1/case02-candidate-failure-adjudication.json`, `reasoning-policy/diagnostic-case02-adjudication.txt`, `reasoning-policy/preliminary-failure-remediation-options.txt`). One section per kind: what the model asserted, what the source showed, which emitted field carried it. Quote sealed text; never copy frozen expected/prohibited strings into code.
- [ ] **Step 2: Write 16 synthetic cases** (2 per kind) in `cases.json`. Synthetic code only; no case IDs, filenames or sentences from the frozen corpus.
- [ ] **Step 3: Validate the JSON** with `bun -e 'JSON.parse(await Bun.file("tests/fixtures/worker/claim-basis/cases.json").text())'` → no error.
- [ ] **Step 4: Commit** `HAR-1138: Add unsupported-claim taxonomy and fixture corpus`.

### Task A2: `basis` attribute contract and deterministic claim-basis guard (HAR-1138)

**Files:**
- Modify: `src/sdk/prompts.ts` (`observationSkeleton` lines 25–63, `renderObservationPrompt` 420–440)
- Modify: `plugin/modes/code.json` (`field_guidance`)
- Modify: `src/sdk/parser.ts` (`parseAgentXml`: read `basis` on `<fact>`)
- Create: `src/services/worker/claim-basis.ts`
- Modify: `src/services/worker/agents/ResponseProcessor.ts` (after `sanitizeObservationFiles`, before `hasStorableTitle`, ~lines 711–742)
- Test: `tests/sdk/prompts.test.ts`, `tests/sdk/parser-basis.test.ts`, `tests/worker/claim-basis.test.ts`, `tests/worker/agents/claim-basis-integration.test.ts`

**Interfaces:**
- Produces: `type FactBasis = 'shown' | 'stated' | 'inferred'`; `parseAgentXml` returns `facts: Array<{ text: string; basis: FactBasis | undefined }>` (keep `facts: string[]` as a derived getter for existing callers).
- Produces: `applyClaimBasis(obs: ParsedObservation, evidence: EvidenceText): { observation: ParsedObservation; report: ClaimBasisReport }` in `claim-basis.ts`, where `EvidenceText = { inputs: string; outputs: string; priorContext: string }` and `ClaimBasisReport = { droppedFacts: number; statedFacts: number; ungroundedTokens: string[]; narrativeRewritten: boolean }`.
- Rules (my call, bounded and general): facts with `basis="inferred"` or no basis are not stored as facts; they go to `metadata.claimBasis.inferred[]`. `basis="stated"` facts are stored prefixed `Source states: `. A code-like token (backticked, or matching `/[A-Za-z_][\w.]*\(|[\w./-]+\.(py|ts|js|cjs|sh|json|md)/`) that appears in a fact or the narrative but not in `inputs+outputs+priorContext` is "ungrounded": the fact is dropped; the narrative is replaced by the subtitle plus the surviving `shown` facts joined as sentences when it contains an ungrounded token. The report is persisted under `metadata.claimBasis`. No case-specific adapters.

- [ ] **Step 1: Write failing contract tests** in `tests/sdk/prompts.test.ts`: rendered skeleton contains `<fact basis="shown|stated|inferred">`; `renderObservationPrompt` text contains the three basis definitions and the sentence "A mechanism or consequence may be asserted only when the shown code performs it; a comment, docstring or commit message is `stated`."
- [ ] **Step 2: Run** `bun test tests/sdk/prompts.test.ts` → FAIL on the new assertions.
- [ ] **Step 3: Implement the prompt and mode text**; run step 1 → PASS.
- [ ] **Step 4: Write failing parser tests** `tests/sdk/parser-basis.test.ts`: basis parsed; missing basis → `undefined`; unknown value → `undefined`.
- [ ] **Step 5: Implement in `parser.ts`**; run → PASS.
- [ ] **Step 6: Write `tests/worker/claim-basis.test.ts`** driven by `cases.json`: for each case assert `report` and stored facts equal `expected`. Add 6 property-style probes (random identifiers present/absent in evidence) asserting no grounded token is ever dropped.
- [ ] **Step 7: Run** → FAIL (module missing).
- [ ] **Step 8: Implement `claim-basis.ts`**; run → PASS.
- [ ] **Step 9: Wire into `ResponseProcessor.ts`** behind the existing document-evidence gate (document evidence wins when eligible; otherwise claim-basis runs on every `ingest`-sourced observation in mode `code`). Write `claim-basis-integration.test.ts` using the `native-file-evidence-failure.test.ts` template (real `SessionStore` in a temp dir, canned reply) asserting stored rows and `metadata.claimBasis`.
- [ ] **Step 10: Run** `bun test tests/worker tests/sdk tests/transcripts` with `CLAUDE_MEM_DATA_DIR=$(mktemp -d)` → PASS; `npm run typecheck` → clean.
- [ ] **Step 11: Commit** `HAR-1138: Add fact basis contract and deterministic claim-basis guard`.

### Task A3: Release `13.32.1-local.3` (HAR-1138)

**Files:**
- Modify: `package.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.grok-plugin/plugin.json`, `claude-mem-cursor/.cursor-plugin/plugin.json`, `claude-mem-grok-bot/.cursor-plugin/plugin.json`, `openclaw/openclaw.plugin.json` (version bump; `sync-plugin-manifests.js` does not write marketplace/grok/openclaw)
- Regenerate: `plugin/scripts/*.cjs` + `.map`, `plugin/bun.lock`

- [ ] **Step 1: Bump version** to `13.32.1-local.3`; run `bun test tests/infrastructure/version-consistency.test.ts` → PASS.
- [ ] **Step 2: Build twice**: `npm run build && sha256sum plugin/scripts/*.cjs > /tmp/b1 && npm run build && sha256sum plugin/scripts/*.cjs | diff - /tmp/b1` → empty diff.
- [ ] **Step 3: Confirm the inlined SDK** `grep -o 'CLAUDE_AGENT_SDK_VERSION="[^"]*"' plugin/scripts/worker-service.cjs` → `0.3.291` (the candidate's `node_modules` under `/home/sk/worktrees/claude-mem-sonnet55` holds it; copy or `bun install` with the pinned `package.json` and verify).
- [ ] **Step 4: Run** `npm run typecheck`, `bun test tests/infrastructure`, and the focused suites from A2 → PASS.
- [ ] **Step 5: Commit** `HAR-1138: Release 13.32.1-local.3 bundles`; push branch; open draft PR #5 against `local/stable` titled `fix(HAR-1138): declare fact basis and drop ungrounded claims`, body linking PR #4 (superseded, left frozen).
- [ ] **Step 6: Wait for CI** `gh run list --branch feature/HAR-1138-claim-basis` → all six Linux jobs SUCCESS; trigger Windows via `workflow_dispatch` if the fork config allows → both jobs SUCCESS. Record run IDs in the PR body.

### Task A4: Independent review and HAR-1138 close-out

- [ ] **Step 1: Dispatch a fresh reviewer** (code-review skill, high effort) over `local/stable...feature/HAR-1138-claim-basis` with the taxonomy doc; fix findings; re-run A3 steps 2–6 if source changed.
- [ ] **Step 2: Document limitations** in `docs/2026-10-20-HAR-1138-unsupported-claims.md`: the guard cannot verify semantic mechanism claims whose identifiers are all present in the evidence (case-2 class); only the `basis` contract plus HAR-1139 measurement covers that.
- [ ] **Step 3: Jira**: comment on HAR-1138 with commit, PR, CI run IDs, test counts; transition to Done via `twg jira workitem transition` (discover transitions first). Record release/source/prompt identities (`sha256sum src/sdk/prompts.ts plugin/modes/code.json`).

### Task A5: New qualification package `evidence-contract-v2` (HAR-1139)

**Files (private, outside git):**
- Create: `/home/sk/.local/state/claude-mem-maintenance/har947-evaluation-20261018/effective-pipeline/evidence-contract-v2/` by copying `evidence-contract-v1/*.ts`, `protocol.json`, `frozen-cases.json`, `audit-template.ts`, `seal-rejected-cohort.py`
- Modify (copy): `common.ts` (`SOURCE=/home/sk/worktrees/claude-mem-har1138`, `TREE`, `PROMPT_SHA`, SDK path/sha, artifact hashes), `paid.ts` (constants: `prior_queries 134`, `max_phase 68`, `global_cap 202`)
- Create: `approved-source-binding.json`, `freeze-manifest.json`, `rendered-input-manifest.json`, `offline-quality-gate.json`, `paid-authorization.json` (`authorized:false` template)
- Update: `effective-pipeline/CURRENT`, `CURRENT.json`, `current-history/`

- [ ] **Step 1: Copy and rebind**; run `bun verify-frozen.ts` → PASS against the new tree.
- [ ] **Step 2: Re-render the 30 cases** with `prepare.ts` (same `frozen-cases.json` sha `57404d89…`; new prompt); write `rendered-input-manifest.json`.
- [ ] **Step 3: Offline gate**: replay the 36 preserved outputs plus the 16 A1 fixtures through `pipeline.ts` (real `processAgentResponse`, temp SQLite) → `offline-quality-gate.json` status `pass`; no network (`credential-env.ts` guard).
- [ ] **Step 4: Dry run** `bun paid.ts --status` → reports `authorized:false`, zero requests, refusal path exercised.
- [ ] **Step 5: Independent review** of the package (fresh subagent): binding, constants, rubric unchanged (`protocol.json.rubric` sha equal to v1), freeze. Write `review.json`.
- [ ] **Step 6: Post the G1 request** on HAR-1139: exact release, request budget 68, cost estimate, stop conditions, fresh-quota requirement. **Stop. Wait for the owner.**

### Task A6: Run the cohort under G1 (HAR-1139)

- [ ] **Step 1: On G1**, write `paid-authorization.json` (`authorized:true`, protocol and freeze hashes, expiry 7 days); verify quota snapshot age ≤600 s and weekly <92% via `quota.ts`.
- [ ] **Step 2: Loop** `bun paid.ts --next` one call at a time; after each pair write the manual audit (`audit-template.ts`, HARD_KEYS); the runner halts on the first candidate hard-gate failure (`TERMINAL-PAID-FAILURE.json`).
- [ ] **Step 3: Terminal accounting** `finalize.ts`; seal (`seal-rejected-cohort.py` or the accepted-cohort equivalent); SHA256 the seal.
- [ ] **Step 4: Independent integrity review** (fresh subagent) → `terminal-integrity-review.json`.
- [ ] **Step 5: Record the decision** on HAR-1139 (accepted / rejected, requests used, list cost, seal SHA) and in PROVIDER-STATE.md. If rejected: close HAR-1139 with the rejection and raise **D1** on HAR-947. If accepted: HAR-1139 Done; HAR-947 may proceed to A7.

### Task A7: Rebind the deployment packet and canary tooling to the accepted release (HAR-947)

**Files:**
- Private: `/home/sk/.local/state/claude-mem-maintenance/har947-release-agent/attribution-followup-20261018/deployment-prep/` (rebind script, `settings-baseline.json`, `private-stage-<release>/plugin`)
- Modify (server-setup): `scripts/claude-mem-observer-provider.sh` (`sonnet55` profile adds `CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off`), `docs/runbooks/claude-mem-sonnet55.md`
- Use: `scripts/claude-mem-watch.py --prepare-units` with the real cutover time

- [ ] **Step 1: Rebind** the packet to the A3 release head; run the 50 hermetic controls → PASS; manifest diff recorded.
- [ ] **Step 2: Profile apply test** against a disposable worker (private data dir) proves the 29 SKIP_TOOLS names, 0.95 threshold, concurrency 2 and `QUOTA_FALLBACK_PROVIDER=off` survive `--apply sonnet55` and `--apply sonnet45` round trips; `scripts/tests/test-claude-mem-provider.py` extended → PASS.
- [ ] **Step 3: Canary readiness receipt** regenerated (`canary-readiness-<ts>.json`) listing: release, settings baseline SHA, B2 boundary tool version, watch unit files (not installed).
- [ ] **Step 4: Commit** server-setup changes `HAR-947: Pin fallback off in the sonnet55 profile`; PR; CI green.

### Task A8: Cutover window (G2 + G3) and canary (HAR-947)

- [ ] **Step 1: Pre-window** (T−1 h): `claude-mem-quiet-boundary.sh --check` (B2), `claude-mem-candidate-preflight.sh --check` against the A3 release, fresh quota and OAuth probe (no model call), PROVIDER-STATE entry with the owner's G2/G3 text.
- [ ] **Step 2: Boundary** `claude-mem-quiet-boundary.sh --arm` → receipt with queueDepth 0, waiters 0, parked 0 sustained, spool inventory, consumed-marker reconciliation, VACUUM INTO backup `quick_check ok`.
- [ ] **Step 3: Replace** `claude-mem-adopt-candidate.sh --apply --service` (B3): stops local.1 via `/api/admin/shutdown`, installs the release root, `systemctl --user start claude-mem-worker.service`, verifies MainPID == `/api/health.pid`, version, cgroup, then `--disarm` intake and watches the spool drain to zero.
- [ ] **Step 4: Proof** one real native tool capture → `Observer model identity` INFO line (reported model `claude-sonnet-5-5`, fallback false, response sha) → stored observation row with source backlink → `mcp-search` query returns it with Chroma `connected:true` (D4 probe shows `dependency_degraded 0`). Record all four identifiers in the receipt. If Chroma stays degraded, stop and roll back per B3 (the pydantic pin is the expected fix; this is the test of it).
- [ ] **Step 5: Install the finite watch units** from A7 (`systemctl --user link` + `start` the two timers); 24 h and 48 h checkpoints written; `claude-mem-canary --candidate --since <cutover>` gate: ≥30 non-sk rows, ≥2 projects, 0 exact duplicates; manual grounding read of 30 rows (same protocol as 2026-09-11) → zero request-as-completion, factual error rate recorded.
- [ ] **Step 6: Decision** on HAR-947: promote (Done) or reject (rollback to local.1 + `--apply sonnet45`; D1). Update Confluence 95354881, PROVIDER-STATE.md, `deployment.json` (`workerPid`, unit name), memory note.

---

## Track B — worker ownership and queue safety

### Task B1: `claude-mem-worker.service` user unit, launcher and doctor (HAR-1140, dotfiles)

**Files:**
- Create: `systemd/.config/systemd/user/claude-mem-worker.service`
- Create: `bin/claude-mem-worker-launch` (resolves the active plugin root from `~/.claude/plugins/installed_plugins.json`, refuses to start unless `CLAUDE_MEM_WORKER_AUTOSTART=false` is present in `~/.claude-mem/settings.json`, execs `/home/sk/.bun/bin/bun <root>/scripts/worker-service.cjs --daemon` in the foreground)
- Create: `bin/claude-mem-worker-doctor` (`--check` only: unit enabled+active, MainPID == `/api/health.pid`, `/proc/<pid>/cgroup` ends in `claude-mem-worker.service`, exactly one `worker-service.cjs --daemon` process, AUTOSTART flag set, `known_marketplaces.json` autoUpdate false)
- Create: `tests/claude-mem-worker.bats` (or the repo's existing shell-test pattern; follow `herdr-doctor`'s)
- Modify: `docs/herdr.md` (background worker section: point at the service)

**Interfaces:**
- Unit: `Type=simple`, `Slice=app.slice`, `Restart=on-failure`, `RestartSec=5`, `KillMode=mixed`, `KillSignal=SIGTERM`, `TimeoutStopSec=45`, `ExecStop=/usr/bin/curl -fsS -X POST http://127.0.0.1:37777/api/admin/shutdown` (worker also handles SIGTERM → `shutdown('signal')`), `Environment=CLAUDE_MEM_DATA_DIR=%h/.claude-mem`, `WantedBy=default.target`.

- [ ] **Step 1: Confirm how `CLAUDE_MEM_WORKER_AUTOSTART` is read** (`src/shared/worker-autostart.ts:1-12`: env vs settings file). If env-only, extend the launcher doc to require it in the hook environment too (`~/.zshenv`); record the finding in the unit's comment header.
- [ ] **Step 2: Write the bats tests** for the launcher: refuses without the flag; resolves the root; `--check` of the doctor on a fake tree passes/fails as designed.
- [ ] **Step 3: Run** → FAIL. Implement launcher and doctor. Run → PASS. `shellcheck` clean.
- [ ] **Step 4: Disposable lifecycle test** (script `tests/claude-mem-worker-lifecycle.sh`, private `CLAUDE_MEM_DATA_DIR`, port 37778, unit instance `claude-mem-worker-test.service` via `systemd-run --user --unit`): start → health ok; `systemctl --user restart` → new PID, health ok within 15 s; two `start` calls → one process; `systemctl --user stop` → clean sentinel `.worker-clean-shutdown` present.
- [ ] **Step 5: Herdr independence**: with the test unit running, `systemctl --user restart herdr.service` (or a dummy unit standing in for it in CI) → worker PID unchanged, cgroup unchanged.
- [ ] **Step 6: Hook no-spawn proof** (fork worktree, private data dir with `CLAUDE_MEM_WORKER_AUTOSTART=false`): run `bun plugin/scripts/worker-service.cjs start`, the SessionStart hook, and the version-mismatch path from `tests/shared/worker-utils-version-recycle.test.ts` → no spawn, no SIGKILL; extend that test file with the flag case if absent.
- [ ] **Step 7: Commit** dotfiles `HAR-1140: Add claude-mem-worker user service, launcher and doctor`; PR; do **not** enable on mahadev (G2).

### Task B2: Quiet-boundary tool that works against the live local.1 (HAR-1140, fork)

**Files:**
- Create: `ops/local-maintenance/claude-mem-quiet-boundary.sh` (`--check | --arm | --disarm | --status`), port of the private `drain-guard.py` logic
- Create: `ops/local-maintenance/tests/quiet-boundary.test.ts` (bun; drives the script against a stub worker on a private port)
- Modify: `docs/local-stable-runbook.md` (step 4 → "quiet boundary")

**Interfaces:**
- `--arm` pauses intake, waits for `queueDepth==0 && parkedSessions==0` for 6 consecutive 10 s samples, inventories `state/hook-spool/` (count, bytes, sha256 list, retained `session_end` entries), reconciles `hook_spool_consumed` rows against spool files, takes `VACUUM INTO` + `quick_check`, hashes the last 36 h of logs, writes `boundary-<ts>.json` (`restartSafe: true|false` with reasons). `--disarm` resumes intake. `--check` runs read-only and prints the same JSON with `restartSafe` computed but no arm.
- Intake pause mechanism (decided in step 1): preferred for future releases is a new `POST /api/admin/intake {paused}` route (added in C1/D5); for the current local.1 worker, which has no such route, the external gate is an nftables rule rejecting new TCP connections to `127.0.0.1:37777` except from the boundary script's own cgroup, **provided step 1 proves hooks fall back to the spool on connection failure**. If they do not, `--arm` instead prints the producer-quiesce checklist and refuses to report `restartSafe:true` until the operator confirms.

- [ ] **Step 1: Determine the ingress path** on `local/stable`: read `src/shared/worker-utils.ts` (`ensureWorkerRunning`, event POST), `src/cli/spool-hook-event.ts`, `src/services/worker/hook-spool-drain.ts`; write the finding (direct POST? spool fallback on ECONNREFUSED? both?) into the script header and the runbook.
- [ ] **Step 2: Write the bun test** with a stub HTTP worker that answers `/api/processing-status` from a scripted sequence (non-zero → zero → zero…), a temp spool dir, and a temp SQLite with `hook_spool_consumed`; assert `restartSafe` flips only after six zero samples and a clean spool reconciliation; assert `--check` never writes.
- [ ] **Step 3: Run** → FAIL; implement; run → PASS; `shellcheck` clean.
- [ ] **Step 4: Intake-gate test** (needs sudo -n): arm against the stub on 37778; a hook-shaped POST from another shell gets ECONNREFUSED while the script's own curl succeeds; `--disarm` removes the rule; the rule is idempotent and survives a second `--arm`.
- [ ] **Step 5: Live `--check` only** against PID 36177: prints JSON, exits non-zero today (`queueDepth 1949`, Chroma degraded) — proof it can fail.
- [ ] **Step 6: Commit** `HAR-1140: Add quiet-boundary tool with intake gate and spool reconciliation`.
- [ ] **Step 7: Review Focus #2 test**: in the bun test, write 3 spool files while armed, then `--disarm`; assert the stub receives exactly 3 nudged events and the retained `session_end` file is left in place.

### Task B3: Adoption script uses the service and the boundary receipt (HAR-1140, fork)

**Files:**
- Modify: `ops/local-maintenance/claude-mem-adopt-candidate.sh` (lines 87, 122–127, 228–243, 270): add `--service` (start via `systemctl --user start claude-mem-worker.service`, verify `MainPID`), require `--boundary <boundary-json>` with `restartSafe:true` unless `--allow-queue`, replace hard-coded `OLD_TAG` with the tag computed from the installed version, post-start proof block (health version, cgroup, spool drained after `--disarm`, first stored observation id).
- Modify: `ops/local-maintenance/claude-mem-candidate-preflight.sh` (check 7 accepts a boundary receipt)
- Test: `ops/local-maintenance/tests/adopt-candidate-dryrun.test.ts` (stub worker, temp roots)

- [ ] **Step 1: Write the dry-run test**: `--check --service --boundary fixture.json` passes; with `restartSafe:false` exits 20; `--apply` is never invoked in tests.
- [ ] **Step 2: Run** → FAIL; implement; run → PASS.
- [ ] **Step 3: Rollback path**: `--rollback` restarts the previous root through the same service (not a scope) and re-points registries; dry-run test asserts the ordered commands.
- [ ] **Step 4: Commit** `HAR-1140: Adopt candidates through the worker service behind a boundary receipt`.

### Task B4: End-to-end rehearsal on a disposable worker (HAR-1140)

**Files:**
- Create: `ops/local-maintenance/tests/handoff-rehearsal.sh` (private data dir, port 37778, test unit, stub OpenAI-compatible server `tests/helpers/stub-openai-server.ts` returning canned observation XML)
- Create: `docs/2026-10-30-HAR-1140-handoff-rehearsal.md`

- [ ] **Step 1: Script the rehearsal**: start worker A (local.1 bundle) under the test unit on the stub provider → spool 40 synthetic events with unique `tool_use_id`s → arm boundary → confirm 0/0/0 → 10 more events arrive and sit in the spool → adopt (B3) to the A3 bundle → disarm → wait.
- [ ] **Step 2: Assert** 50 observations stored, 50 distinct `tool_use_id` provenance values, zero duplicates (`SELECT count(*), count(DISTINCT …)`), `hook_spool_consumed` has 50 rows, spool empty except retained kinds, worker B PID == MainPID.
- [ ] **Step 3: Negative control**: repeat without `--arm` (SIGKILL worker A mid-batch) → fewer than 50 stored; the test must show loss to prove the boundary matters.
- [ ] **Step 4: Run both** → PASS/expected loss; write the doc with receipts.
- [ ] **Step 5: Independent review** (fresh subagent) of B1–B4 and the runbook; fix; Jira comment on HAR-1140 with evidence; request **G2** on HAR-947/HAR-1140.

### Task B5: Durable pending queue with crash recovery (HAR-1141, on `candidate/v14.0.1` after C1)

**Files:**
- Create: `src/services/sqlite/pending-events.ts` (table `pending_events`: `event_id TEXT PRIMARY KEY, session_db_id INTEGER, kind TEXT, payload_json TEXT, state TEXT CHECK(state IN ('enqueued','claimed','stored','acked','failed','quarantined')), claim_token TEXT, claim_expires_at INTEGER, attempts INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, observation_ids TEXT`; index on `(state, created_at)`)
- Modify: `src/services/sqlite/SessionStore.ts` (register as fork migration id `9001` in `schema_versions`; do **not** raise `PRAGMA user_version` above 67 — confirmed semantics in C3)
- Modify: `src/services/worker/SessionMessageBuffer.ts` (write-through on enqueue before `markHandedOff`; claim → `claimed` with 10-minute lease; ack → `acked`)
- Modify: `src/services/worker/agents/ResponseProcessor.ts` (`storeObservations` and the `pending_events` → `stored` update in one transaction)
- Modify: `src/services/worker-service.ts` boot: `recoverPendingEvents()` re-enqueues `enqueued` and lease-expired `claimed` rows, skips `event_id`s already present as observation provenance, quarantines after 3 attempts
- Test: `tests/sqlite/pending-events.test.ts`, `tests/worker/pending-events-recovery.test.ts` (subprocess fixture killed with SIGKILL at four points: before claim, during generation, after store before ack, after ack), `tests/worker/pending-events-privacy.test.ts` (SKIP_TOOLS payloads never persisted)

- [ ] **Step 1: Write the table and migration tests** → FAIL → implement → PASS.
- [ ] **Step 2: Write the four kill-point recovery tests** using the `document-evidence-lifecycle.ts` fixture pattern → FAIL → implement write-through, lease and boot sweep → PASS; assert exactly-once storage across the commit boundary and explicit `quarantined` after three failures.
- [ ] **Step 3: Simulated reboot**: new process, same temp DB, RAM `seen` set empty → no duplicate observation.
- [ ] **Step 4: Expose** `oldestPendingAgeMs`, `inFlightAgeMs`, `quarantined` in `/api/processing-status` (coordinates with D5).
- [ ] **Step 5: Commit** `HAR-1141: Persist pending events with lease recovery and idempotent ack`; document the limit that pre-2026-10 backlog is not recoverable.

---

## Track C — upstream v14.0.1 integration and release gates

### Task C1: Build `candidate/v14.0.1` by re-expressing the fork delta (HAR-1103)

**Files:** (all in `/home/sk/worktrees/claude-mem-candidate-14.0`, created with `git worktree add … -b candidate/v14.0.1 v14.0.1`)
- (i) `.github/workflows/ci.yml` (branch filter `[main, local/stable, 'candidate/**']`), `tests/infrastructure/version-consistency.test.ts` (full semver), version `14.0.2-local.1` across the 10 manifests
- (ii) `scripts/audit-local-install.cjs` (+ re-carry `a5c9fad7` `checkActiveClaudeInstall` and `d68e7eed` `checkClaudeSettingsMarketplace` → 18 checks; audit compares against `deployment.json.commit`, not host HEAD), `ops/local-maintenance/*` from B2/B3
- (iii) `src/services/sync/ChromaMcpManager.ts`: keep `pydantic==2.12.5` (exact, proven) over upstream's `<2.14`; preserve upstream's orphan-holder and writer-lock fixes
- (iv) `src/sdk/hardened-options.ts`: map the Sonnet 5.5 adaptive/high policy onto upstream's `CLAUDE_MEM_OBSERVER_THINKING` (`disabled|enabled|omit` + one retry without thinking): add value `adaptive` and setting `CLAUDE_MEM_OBSERVER_EFFORT` (`high` for `claude-sonnet-5-5`, default omitted); `SettingsDefaultsManager.ts` defaults `CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER='off'` for the fork
- (v) port `document-evidence.ts`, `claim-basis.ts` (A2), native-file outcome repair, model receipt onto upstream `ClaudeProvider.ts` / `GeneratorRunner.ts` / `ResponseProcessor.ts` / `transcripts/processor.ts` (after A2 merges)
- (vi) storage-exception policy (my call): on a throw inside response processing, do **not** ACK, release the claimed batch (candidate behaviour), and let the runner's poison/respawn path bound retries at 3 before parking the session with `abortReason='storage:processing_throw'`; update upstream's `claude-provider-work-preservation.test.ts` ~line 428 expectation and the candidate's `sdk-storage-error` fixture to this single policy
- (vii) drop fork patches for #4554–#4557 and their fork-only tests; keep upstream's tests
- (viii) settings/behaviour audit: batch size 1, `OBSERVER_THINKING` per model, `WORK_STATE_ENABLED`/`MEMORY_SEARCH_HOOK_ENABLED` defaults reviewed and recorded; TeamBrain off (`CLAUDE_MEM_TEAMBRAIN_URL` empty) and its two un-loopback-guarded routes noted in the inventory

- [ ] **Step 1: Create the worktree**; `bun install` in `plugin/` with `--frozen-lockfile`; `npm run typecheck` on untouched v14.0.1 → baseline recorded.
- [ ] **Step 2: Apply (i)**; version test PASS; commit `HAR-1103: Run CI on fork branches and allow local prerelease versions`.
- [ ] **Step 3: Apply (ii)**; `node scripts/audit-local-install.cjs --help` runs; unit tests for the 6 re-carried checks PASS; commit.
- [ ] **Step 4: Apply (iii)+(iv)+(viii)** with tests (`tests/sdk/hardened-options-thinking.test.ts` ported; new `tests/shared/settings-defaults-fork.test.ts` asserting `QUOTA_FALLBACK_PROVIDER` default `off`); commit each.
- [ ] **Step 5: Apply (vi)+(vii)**; `bun test tests/worker/claude-provider-work-preservation.test.ts` PASS with the single policy; commit.
- [ ] **Step 6: Apply (v)** once A2 is merged; port tests; commit.
- [ ] **Step 7: Full** `CLAUDE_MEM_DATA_DIR=$(mktemp -d) bun test tests` → record failures; classify each as environment (reproduce on untouched v14.0.1) or regression; regressions fixed before C2.

### Task C2: Contract inventory and candidate CI (HAR-1103)

**Files:**
- Create: `ops/upstream-maintenance/patches.json` (one entry per carried patch: `contract`, `purpose`, `commits[]`, `files[]`, `tests[]`, `upstream_pr`, `status: carry|covered_upstream|configuration|retired`, `retire_when`)
- Create: `tests/infrastructure/patch-inventory.test.ts` (every entry's files/tests exist on the branch; every `carry` has ≥1 test; every `covered_upstream` has a merged PR URL; no source diff against the base tag is unexplained by an entry — `git diff --stat v14.0.1 -- src tests` paths ⊆ inventory paths)
- Create: `docs/2026-10-27-v14.0.1-integration.md` (per-contract table covered / still-local / unknown; rulings (iii), (iv), (vi))

- [ ] **Step 1: Write the inventory test** → FAIL → write `patches.json` → PASS.
- [ ] **Step 2: Build twice** (A3 step 2 method) → identical hashes; `committed-plugin-bundles.test.ts` PASS.
- [ ] **Step 3: Push**; CI on `candidate/v14.0.1` → six jobs SUCCESS; Windows two jobs SUCCESS. Record run IDs.
- [ ] **Step 4: Commit the doc**; Jira comment on HAR-1103 with the table; hand the exact candidate commit to C3 and C4.

### Task C3: Schema-67 migration and recovery on a copied database (HAR-1142)

**Files:**
- Create: `ops/local-maintenance/claude-mem-db-migration-rehearsal.sh` (`--check | --run <copy.db>`; private dir under `~/.local/state/claude-mem-maintenance/schema67-rehearsal-<ts>/`; never touches the production path)
- Create: `docs/2026-11-05-schema67-migration-qualification.md`
- Create: `tests/sqlite/schema67-forward-repair.test.ts`
- Create: `src/services/sqlite/repair/title-norm-key.ts` (`repairTitleNormKeys(db): { rewritten: number }` re-running `refreshUnicodeTitleNormKeys` logic idempotently)

- [ ] **Step 1: Fresh copy** `sqlite3 ~/.claude-mem/claude-mem.db "VACUUM INTO '<copy>'"` + `PRAGMA quick_check` → ok; record row counts for `observations`, `session_summaries`, `user_prompts`, `sdk_sessions`, `work_state_entries`, `sync_*`.
- [ ] **Step 2: Run the C2 candidate worker** (stub provider, private port) against the copy → `schema_versions` has 65, 66, 67; `PRAGMA user_version`=67; `integrity_check` ok; row counts unchanged; `work_state_entries` has the four sync columns; `sync_entity_heads` CHECK admits `work_state`; `idx_user_prompts_native_identity` exists; sample 200 `title_norm_key` values equal NFC recomputation.
- [ ] **Step 3: Semantic projection**: 20 fixed FTS/search queries via the worker API return identical ids before and after.
- [ ] **Step 4: Injected failure**: SIGKILL the worker during `refreshUnicodeTitleNormKeys` (breakpoint via a large copy) → restart completes the IMMEDIATE transaction cleanly; no partial state.
- [ ] **Step 5: Old-writer test**: run the installed `13.32.1-local.1` bundle against the migrated copy on a private port → it opens (no fence), writes 5 observations; record that new rows carry old-normalization keys; then run the candidate again → `repairTitleNormKeys` rewrites exactly those rows (test in `schema67-forward-repair.test.ts`).
- [ ] **Step 6: Recovery policy** in the doc: rollback after G4 = old binary over the migrated DB + forward repair on next upgrade; snapshot restore only if zero post-upgrade writes (`max(observations.id)` unchanged). Duplicate-writer check: two workers on the same copy → second refuses (writer lock) or is documented.
- [ ] **Step 7: Independent review**; Jira comment on HAR-1142 with receipts; blocks C4 until approved.

### Task C4: Reproducible release gates and the promotion record (HAR-1143)

**Files:**
- Create: `bun.lock` at repo root (`bun install` with `@anthropic-ai/claude-agent-sdk` pinned exactly `0.3.291`, `@opentelemetry/api 1.9.1`), commit
- Modify: `.github/workflows/ci.yml` (`bun install --frozen-lockfile` at root; new job `release-manifest`)
- Create: `scripts/release-manifest.cjs` (writes `plugin/release-manifest.json`: commit, tree, version, sha256 of each `plugin/scripts/*.cjs`, inlined SDK version, pydantic pin, required settings keys and values, node/bun versions)
- Create: `tests/infrastructure/release-manifest.test.ts` (manifest matches a fresh build; inlined SDK == lockfile SDK; fails on drift)
- Modify: `ops/local-maintenance/claude-mem-candidate-preflight.sh` (verify installed root hashes == manifest)
- Create: `docs/releases/14.0.2-local.1.md` (go/no-go template: gates, receipts, post-deploy checks, rollback)

- [ ] **Step 1: Write `release-manifest.test.ts`** → FAIL → implement the script → PASS.
- [ ] **Step 2: Review Focus #5 test**: temporarily edit the lockfile SDK version in a temp copy → test FAILS; restore.
- [ ] **Step 3: CI**: push; `release-manifest` job SUCCESS; double-build job identical hashes.
- [ ] **Step 4: G5**: prepare `evidence-contract-v3` (A5 method, 10 pairs) bound to the v14 release; request G5; run; record.
- [ ] **Step 5: Promotion record** filled; request **G4**; execute through B3 (`--service --boundary`) in a second window; post-deploy: audit 18/18, D4 probe green, Chroma connected, one capture→vector proof; `deployment.json` updated; HAR-1103/1142/1143 Done with receipts.

---

## Track D — upkeep and monitoring

### Task D1: Patch inventory policy and maintainer record (HAR-1144, fork + docs)

- [ ] **Step 1:** `docs/upstream-upkeep-policy.md`: maintainer Shantanu Khanwalkar; weekly review slot; 14-day stable-patch target; urgent security triage (same day); major upgrades require C3-style migration gates; proposals never deploy or call models.
- [ ] **Step 2:** `ops/upstream-maintenance/patches.schema.json` + validate C2's `patches.json` in `patch-inventory.test.ts`.
- [ ] **Step 3:** Upstream contribution review: for each `carry` entry, record `contribute: yes|no|later` with reason; open issues/PRs only on owner instruction.
- [ ] **Step 4:** Commit `HAR-1144: Add upkeep policy and patch inventory schema`.

### Task D2: Daily upstream release and deprecation check (HAR-1144, server-setup)

**Files:**
- Create: `scripts/claude-mem-upstream-check.py` (`--check` validates config/network-free; default run: GitHub releases API for `thedotmack/claude-mem` latest stable tag vs `patches.json.base_tag`; Anthropic deprecations page parsed for `ops/model-inventory.json` models (D6); prints findings; exit 0 on findings; emits textfile metrics `claude_mem_upstream_releases_behind`, `claude_mem_model_retirement_days{model}`, `claude_mem_upstream_check_timestamp`)
- Create: `systemd/claude-mem-upstream-check.{service,timer}` (user units; `OnCalendar=*-*-* 05:41:00 Asia/Kolkata`, `RandomizedDelaySec=10m`, `Persistent=true`, runs through `timer-metric-wrapper.sh claude-mem-upstream-check -- …`)
- Test: `scripts/tests/test-claude-mem-upstream-check.py` (fixtures for the API JSON and a saved HTML page; register in `ci/tests.json`)

- [ ] **Step 1:** tests → FAIL → implement → PASS; `env -i HOME=$HOME PATH=/usr/bin:/bin ./scripts/claude-mem-upstream-check.py --check` passes.
- [ ] **Step 2:** Commit `HAR-1144: Add daily upstream release and deprecation check`; PR; do not enable (G6).

### Task D3: Weekly isolated upgrade proposal workflow (HAR-1144, fork)

**Files:**
- Create: `.github/workflows/upkeep-proposal.yml` (`schedule: 47 1 * * 0` + `workflow_dispatch`; gated `if: vars.UPKEEP_ENABLED == 'true'`; concurrency group `upkeep`; steps: fetch upstream tags → newest stable tag newer than `base_tag` → `git merge --no-commit <tag>` on a throwaway branch from `local/stable` → conflict list → if no source conflicts, run contract tests → open/update PR `upkeep/<tag>` with the report; never pushes to `local/stable`, never deploys)
- Create: `scripts/upkeep-report.cjs` (renders the PR body from conflict list + `patches.json` + test results)
- Test: `tests/infrastructure/upkeep-report.test.ts`

- [ ] **Step 1:** report test → FAIL → implement → PASS.
- [ ] **Step 2:** `workflow_dispatch` dry run with `UPKEEP_ENABLED` unset → job skipped; set to `true` on a fork test repo variable → one PR opened against a test branch; delete.
- [ ] **Step 3:** Addresses the four 2026-10-02 blockers explicitly in the PR description: register is generated and tested (1); first run after C1 reconciliation (2); audit compares the receipt commit, not host HEAD (3, done in C1 ii); 05:41 / Sunday 01:47 UTC avoid `*:23` (4).
- [ ] **Step 4:** Commit `HAR-1144: Add weekly upstream upgrade proposal workflow`; activation = G6.

### Task D4: Observer processing and retrieval-lag probe with alerts (HAR-1145, server-setup)

**Files:**
- Create: `scripts/claude-mem-observer-probe.py` (`--check`; reads `/api/health`, `/api/processing-status`, `/api/chroma/status`, `~/.claude-mem/observer-health.json`, `quota-cooldown.json`, `chroma-sync-state.json`, SQLite read-only `file:…?mode=ro`; emits: `claude_mem_queue_depth`, `claude_mem_parked_sessions`, `claude_mem_processing{state}`, `claude_mem_observations_total{model,window="15m|1h"}`, `claude_mem_last_stored_age_seconds`, `claude_mem_vector_lag_rows{project}` (= `max(observations.id)` − watermark), `claude_mem_observer_consecutive_failures`, `claude_mem_quota_utilization{window}`, `claude_mem_quota_cooldown_active`, `claude_mem_dependency_degraded`, `claude_mem_reported_model{model}` (from `sdk_sessions.observed_model` last 1 h), `claude_mem_expected_model{model}` (from settings), `claude_mem_worker_pid`, `claude_mem_worker_version{version}`; plus D5 fields when present)
- Create: `systemd/claude-mem-observer-probe.{service,timer}` (user; `OnCalendar=*:0/5` offset `+2m` → `*-*-* *:02/5:00`; through `timer-metric-wrapper.sh`)
- Create: `monitoring/grafana/provisioning/alerting/claude-mem.yml` (warnings → `discord-warnings`; critical → `discord-critical`): `NoCompletionsWithBacklog` (queue>0 and `observations_total[1h]==0` for 2 h, excluding `processing{state="maintenance"}`), `VectorLag` (`vector_lag_rows>200` for 1 h), `DependencyDegraded` (1 h), `ObserverFailing` (`consecutive_failures>=5`), `ModelDrift` (`reported != expected` for 30 min, critical), `ModelRetirementSoon` (`retirement_days<21`), `ProbeStale` (timestamp older than 20 min). Every annotation links `docs/runbooks/claude-mem-observer-alerts.md`; no alert action restarts anything.
- Create: `monitoring/grafana/provisioning/dashboards/json/claude-mem-observer.json`
- Create: `docs/runbooks/claude-mem-observer-alerts.md` (preservation-aware: boundary tool first, never kill)
- Test: `scripts/tests/test-claude-mem-observer-probe.py` (synthetic healthy / idle / quota-stalled / failing-storage / delayed-vector fixtures produce distinct metric sets)

- [ ] **Step 1:** fixtures and tests → FAIL → implement → PASS; `--check` under `env -i` passes; output file mode 0644 via the wrapper.
- [ ] **Step 2:** `scripts/grafana-alerting-reload.py --check` validates the rules file (live `--apply` only under G6).
- [ ] **Step 3:** Commit `HAR-1145: Add observer probe, alert rules and dashboard`; PR.

### Task D5: Worker API fields for backlog age and model identity (HAR-1145, fork on `candidate/v14.0.1`)

**Files:**
- Modify: `src/services/worker/http/routes/DataRoutes.ts` (`/api/processing-status` adds `oldestPendingAgeMs`, `inFlightAgeMs`, `parkedMessages`, `lastStoredAt`, `storageFailures`)
- Modify: `src/services/server/Server.ts` (`/api/health.ai` adds `requestedModel`, `reportedModel`, `fallbackActive`, `credentialProfile`)
- Modify: `src/services/worker/SessionMessageBuffer.ts` (track enqueue timestamps per payload)
- Test: `tests/services/worker/processing-status-ages.test.ts`, `tests/servers/health-model-identity.test.ts`

- [ ] **Step 1:** tests → FAIL → implement → PASS; D4 probe reads the new fields when present (fixture added).
- [ ] **Step 2:** Commit `HAR-1145: Report pending ages and model identity from the worker API`.

### Task D6: Model/runtime inventory and CLI-route assessment (HAR-1145)

- [ ] **Step 1:** `ops/model-inventory.json` in server-setup: `{ model, route: "claude-cli-oauth", deprecated_on, retires_on, floor, replacement, reminder_days: [60,30,14,7] }` for `claude-sonnet-4-5-20250929`, `claude-sonnet-5-5`, `claude-haiku-5-5`; consumed by D2 and D4.
- [ ] **Step 2:** `docs/runbooks/claude-mem-cli-route-check.md`: weekly owner-run probe `claude -p "reply ok" --model <model>` (one request, recorded with date and CLI version) as the only evidence of route availability; the deprecations page is API-only by its own scope statement.
- [ ] **Step 3:** Commit `HAR-1145: Add model retirement inventory and CLI route check`.

---

## Track E — HAR-1136 (non-blocking)

### Task E1: File-metadata coverage reporting

- [ ] **Step 1:** `docs/file-metadata-coverage.md`: which captured forms establish a path and role (native file tools, `apply_patch` with paired outcome, Bash heredoc/`python -c` literals as "unenumerated"), and the known gaps (uncaptured `$HOME`, variable expansion).
- [ ] **Step 2:** `src/services/worker/file-evidence-coverage.ts`: `summarizeFileEvidenceCoverage(claims): { known: number; unresolved: number; unenumerated: number }` stored under `metadata.fileEvidence.coverage`; never guesses paths.
- [ ] **Step 3:** fixtures: success, failure, partial, quoting, variable-expansion, unknown-source → tests PASS.
- [ ] **Step 4:** Commit `HAR-1136: Report file-evidence coverage limits per observation`.

---

## Execution notes

- Run tracks A, B and C concurrently with one implementer subagent per task and a fresh reviewer per task; D and E after C1 lands. Reserve files through Agent Mail before editing (project key `/home/sk/development/tools/claude-mem`).
- Checkpoints to Jira after each task (comment with commit, PR, CI run, test counts). Gates are requested on the ticket that owns them and echoed in PROVIDER-STATE.md.
- Known open facts to settle during execution (not blockers): how `CLAUDE_MEM_WORKER_AUTOSTART` is read (B1 step 1); whether hooks fall back to the spool on connection refusal (B2 step 1); `PRAGMA user_version` semantics for a fork-local migration id (C3).
