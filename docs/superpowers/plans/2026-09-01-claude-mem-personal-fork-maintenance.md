# Claude-Mem Personal Fork Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the local observation-grounding patch in a personal GitHub fork and automatically rebase, verify, deploy, and cache-bust it whenever upstream claude-mem advances.

**Architecture:** A durable clone at `/home/sk/development/tools/claude-mem` stays checked out on clean `main`, owns a free local patch branch, and has `origin` set to the personal fork plus `upstream` set to `thedotmack/claude-mem`. A fail-closed maintainer installed at `/home/sk/.local/bin/claude-mem-local-maintain` rebases a detached candidate worktree, runs the project quality gates, pushes only verified history, and deploys only when the live worker queue is idle. A persistent user-systemd timer invokes the installed maintainer daily; conflicts, test failures, busy queues, and deployment failures leave the currently running cache untouched.

**Tech Stack:** Git/GitHub CLI, Bash, Bun tests/build, Codex plugin CLI, systemd user services, jq, curl, flock.

**Spec:** Approved maintenance design in this conversation; tracking issue [HAR-947](https://tattvi.atlassian.net/browse/HAR-947); model-quality page [Confluence 95846401](https://tattvi.atlassian.net/wiki/spaces/Harmony/pages/95846401).

## Global Constraints

- Never use a versioned Claude/Codex cache directory as source of truth.
- Never mutate the durable local branch until candidate rebase and verification pass.
- Never deploy while the latest worker status reports a nonzero queue depth.
- Never delete or overwrite the live plugin/cache on rebase conflict, verification failure, or deployment failure.
- Keep exactly one active claude-mem worker/plugin data path using `/home/sk/.claude-mem`.
- Preserve upstream numeric version and apply the Codex cachebuster only after the build.
- Use `gemini-flash-lite-latest`; model-quality escalation remains tracked separately in HAR-947.
- Write no credentials, API keys, tokens, or credential-bearing command output to maintenance logs.

---

### Task 1: Persist the Existing Grounding Patch in a Personal Fork

**Files:**
- Modify: existing Git history on `fix/gemini-observation-grounding`
- Create: GitHub repository `shantanukhanwalkar/claude-mem` as a fork of `thedotmack/claude-mem`
- Create: `/home/sk/development/tools/claude-mem/`

**Interfaces:**
- Consumes: the verified 12-file grounding/skip-protocol diff in `/home/sk/worktrees/claude-mem-gemini-observation-grounding`
- Produces: pushed branch `local/observation-grounding`, durable clone with `origin` personal and `upstream` official

- [ ] **Step 1: Verify and commit the existing patch**

Run the 84-test scoped suite, TypeScript, build, and `git diff --check`, then commit all source, tests, generated bundles, and this plan as:

```text
fix(observer): ground Gemini observations in tool evidence
```

- [ ] **Step 2: Create the personal GitHub fork**

Run:

```bash
gh repo fork thedotmack/claude-mem --clone=false --remote=false
```

Expected: `https://github.com/shantanukhanwalkar/claude-mem` exists with parent `thedotmack/claude-mem`.

- [ ] **Step 3: Push the customization branch**

Run:

```bash
git push git@github.com:shantanukhanwalkar/claude-mem.git \
  fix/gemini-observation-grounding:local/observation-grounding
```

Expected: remote branch commit equals the local committed patch.

- [ ] **Step 4: Clone the durable fork and add upstream**

Run:

```bash
git clone git@github.com:shantanukhanwalkar/claude-mem.git \
  /home/sk/development/tools/claude-mem
git -C /home/sk/development/tools/claude-mem remote add upstream \
  git@github.com:thedotmack/claude-mem.git
git -C /home/sk/development/tools/claude-mem fetch upstream --tags
git -C /home/sk/development/tools/claude-mem fetch origin \
  local/observation-grounding:local/observation-grounding
```

Expected: durable clone is clean; both remotes resolve; the local branch matches the pushed commit.

- [ ] **Step 5: Verify the durable clone baseline**

Run:

```bash
bun install --frozen-lockfile
bun test tests/sdk/prompts.test.ts tests/sdk/parser.test.ts \
  tests/sdk/output-classifier.test.ts tests/gemini_provider.test.ts \
  tests/worker/openai-compatible-summary-tier.test.ts \
  tests/worker/agents/response-processor.test.ts
bunx tsc --noEmit
```

Expected: 84 tests pass, zero failures; TypeScript exits zero.

### Task 2: Implement a Fail-Closed Maintenance Script with TDD

**Files:**
- Create: `scripts/claude-mem-local-maintain.sh`
- Create: `tests/scripts/claude-mem-local-maintain.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_MEM_FORK_ROOT`, `CLAUDE_MEM_LOCAL_BRANCH`, `CLAUDE_MEM_UPSTREAM_REF`, `CLAUDE_MEM_STATE_DIR`, optional test hooks
- Produces: verified rebased local branch, pushed fork branch, deployment marker `deployed-commit`, journal output, exit codes 0 success/no-op, 20 deferred-busy, nonzero failure

- [ ] **Step 1: Write the candidate-success failing test**

Create real temporary upstream/fork repositories, add one upstream commit and one local patch commit, provide executable verification/deploy hooks, run the script, and assert:

```typescript
expect(result.exitCode).toBe(0);
expect(localBranch).toContain(upstreamCommit);
expect(localBranch).toContain(localPatch);
expect(readFileSync(deployedMarker, 'utf8').trim()).toBe(localHead);
expect(commandLog).toContain('verify');
expect(commandLog).toContain('deploy');
```

- [ ] **Step 2: Run RED for the missing script**

Run:

```bash
bun test tests/scripts/claude-mem-local-maintain.test.ts
```

Expected: FAIL because `scripts/claude-mem-local-maintain.sh` does not exist.

- [ ] **Step 3: Implement candidate creation, rebase, verification, branch update, and deployment state**

The script must:

```bash
set -euo pipefail
exec 9>"$STATE_DIR/maintenance.lock"
flock -n 9 || exit 0
git -C "$FORK_ROOT" fetch upstream --tags --prune
git -C "$FORK_ROOT" fetch origin --prune
git -C "$FORK_ROOT" worktree add --detach "$CANDIDATE" "$LOCAL_BRANCH"
git -C "$CANDIDATE" rebase "$UPSTREAM_REF"
```

Then run either the injected test hook or the real 84-test/TypeScript/build verification. Update and push the local branch only after verification succeeds. Deploy only through the injected test hook or the real deploy function, then atomically write `deployed-commit`.

- [ ] **Step 4: Run GREEN for candidate success**

Run the single test and expect PASS.

- [ ] **Step 5: Add conflict and verification-failure tests**

Use real conflicting Git commits and a failing verification hook. Assert both paths leave the local branch and deployment marker unchanged and never invoke deploy.

- [ ] **Step 6: Run RED, implement trap cleanup and fail-closed exits, then run GREEN**

The cleanup trap must abort any candidate rebase and remove the candidate worktree/temp directory without touching the durable working tree.

- [ ] **Step 7: Add busy-queue deferral test**

Set the worker-status test hook to return `queueDepth=2`. Assert exit code 20, verified branch push completed, deploy did not run, and `deployed-commit` remains old.

- [ ] **Step 8: Implement the real deploy boundary**

The real deploy function must:

```bash
python3 /home/sk/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugin
npm run sync-marketplace
codex plugin add claude-mem@claude-mem-local --json
npm run worker:restart
```

Before deployment, read the latest UTC-dated worker log and require its most recent processing status to contain `queueDepth=0`. After restart, require `/health` status `ok`, the installed worker bundle to contain the grounding and skip markers, and `observer-health.json` to report zero consecutive failures.

- [ ] **Step 9: Run the complete maintenance-script test suite**

Expected: success, conflict, verification failure, busy deferral, and no-upstream-change tests all pass.

- [ ] **Step 10: Commit the maintenance script**

Commit as:

```text
feat(local): automate upstream rebase and safe plugin deployment
```

### Task 3: Install Persistent User-Systemd Automation

**Files:**
- Create: `ops/local-maintenance/claude-mem-local-maintenance.service`
- Create: `ops/local-maintenance/claude-mem-local-maintenance.timer`
- Create: `ops/local-maintenance/install.sh`
- Create: `tests/scripts/claude-mem-local-maintenance-install.test.ts`
- Create at deployment: `/home/sk/.local/bin/claude-mem-local-maintain`
- Create at deployment: `/home/sk/.config/systemd/user/claude-mem-local-maintenance.service`
- Create at deployment: `/home/sk/.config/systemd/user/claude-mem-local-maintenance.timer`

**Interfaces:**
- Consumes: durable clone path and maintenance script
- Produces: daily persistent timer and journal-visible result

- [ ] **Step 1: Write the installer failing test**

Run `install.sh` against a temporary `SYSTEMD_USER_DIR`, then assert unit contents, executable paths, `OnCalendar=*-*-* 04:15:00 Asia/Kolkata`, `RandomizedDelaySec=15m`, and `Persistent=true`.

- [ ] **Step 2: Run RED, implement units and installer, then run GREEN**

The service must be `Type=oneshot`, run `/home/sk/.local/bin/claude-mem-local-maintain --apply`, set `TimeoutStartSec=45min`, and harden writes to the user home while retaining required network access. The installer copies the maintainer and units atomically, runs `systemctl --user daemon-reload`, and enables/starts the timer.

- [ ] **Step 3: Install and verify the live timer**

Run the installer, then verify:

```bash
systemctl --user is-enabled claude-mem-local-maintenance.timer
systemctl --user is-active claude-mem-local-maintenance.timer
systemctl --user list-timers claude-mem-local-maintenance.timer
```

- [ ] **Step 4: Commit systemd automation**

Commit as:

```text
feat(local): schedule fail-closed claude-mem maintenance
```

### Task 4: Run Initial Maintenance and Record Operations

**Files:**
- Modify: HAR-947 comments
- Modify: Confluence page 95846401

**Interfaces:**
- Consumes: installed timer and durable fork
- Produces: verified no-op or successful maintenance run, documented rollback/monitoring commands

- [ ] **Step 1: Run a dry-run/no-op maintenance cycle**

Run the script with `--check`; verify it fetches both remotes, constructs and verifies a candidate when needed, and performs no deployment mutation.

- [ ] **Step 2: Run an apply cycle**

Require queue depth zero, run `--apply`, and verify source branch, fork branch, Codex plugin version/cachebuster, worker PID/version, bundle markers, observer health, and queue depth.

- [ ] **Step 3: Verify fail-closed rollback properties**

Confirm the previous cache directory remains present, the durable branch is pushed, and a failed synthetic verification hook cannot change `deployed-commit` or the running worker PID.

- [ ] **Step 4: Update Jira and Confluence**

Record fork URL, durable clone path, branch, timer name/schedule, verification evidence, manual commands, and recovery procedure in HAR-947 and Confluence page 95846401.

- [ ] **Step 5: Final verification**

Run maintenance tests, the 84-test plugin suite, TypeScript, build, unit validation, live systemd status, GitHub fork/branch readback, Codex plugin list, worker health, and Atlassian readbacks. Report the pre-existing full-suite timezone/order pollution separately rather than claiming the entire upstream suite is green.
