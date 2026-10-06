# Contract 6 probes against upstream v13.32.0, and the carried fix

**Contract 6:** buffered work is preserved across stream failure and recycle.

The fork (`local/stable`) implemented this by serialising SDK turns through a
`TurnGate` in `ClaudeProvider` and naming three stream exits
(`stream:failed_result`, `stream:unexpected_eof`, `stream:interrupted`) that
`GeneratorExitHandler` treated as pause-and-preserve. Upstream replaced that
with `ObserverResponsePacer` (#4066), a once-only re-queue of a batch whose
turn failed before emitting text (`retriedAfterErrorResult` →
`resetProcessingToPending`), a `transport:response_stall` exit, and
`PRESERVED_ABORT_CATEGORIES` in `abort-reason.ts`.

Rulings, in order: (1) do not port `TurnGate`; probe the contract against
upstream's mechanism and report. (2) The probes failed on six of twelve
scenarios, so contract 6 gets a minimal carried patch in `ClaudeProvider.ts`
shaped to be cherry-picked onto upstream main — not a `TurnGate` port.

Probe file: `tests/worker/claude-provider-work-preservation.test.ts`
(16 probes; 14 plain `it`, 2 `it.failing`). Harness style follows upstream's
`tests/worker/claude-provider-response-pacing.test.ts`: real `ClaudeProvider`,
`SessionManager` and `SessionMessageBuffer`; a fake SDK that pumps the prompt
iterator eagerly (as the real `query()` does) and can answer, fail a turn,
end, or throw from its output iterator; then the real `handleGeneratorExit`
on whatever `abortReason` the run left behind. Every probe asserts an
observable outcome (claims released, pending count, abort category, session
finalized or not, generator released within a timeout), never the mechanism.

Run: `CLAUDE_MEM_DATA_DIR=$(mktemp -d) bun test tests/worker/claude-provider-work-preservation.test.ts`

## What is carried

`src/services/worker/ClaudeProvider.ts`, +65/−1 lines, no other `src` file.

**The loss path.** Upstream's `startSession` loop handles every *result-driven*
exit (quota guard, stall, the `ResponseProcessor` pauses) and every *abort*
(idle, shutdown, recycle, provider switch) by naming `session.abortReason`.
Two exits named nothing: the `for await` over `query()` ending with no result
(the SDK child exited mid-conversation) and the loop throwing (the output
iterator broke, or `processAgentResponse` did). Both left the batch claimed
and `abortReason === null`, so `GeneratorRunner`'s finally handed `null` to
`handleGeneratorExit`, which finalizes the session and disposes the buffer.
The claimed batch — and, during an init turn, the whole unclaimed backlog —
was gone. A generator parked in the message drain between turns was also
never released: `pacer.close()` wakes a wait on the pacer, not on the drain,
so it sat until the 3-minute idle timeout.

**The two points.**

1. After the `for await (const message of queryResult)` loop, still inside the
   `try`:
   ```ts
   if (!session.abortReason) {
     await this.releaseClaimedBatchForTransportExit(session, 'transport:sdk_eof');
   }
   ```
2. In the `catch`, after the existing spawn-failure classification (which
   throws and so never reaches this line):
   ```ts
   if (!session.abortReason && !isClassified(error) && !isInvalidApiKeyError(error)) {
     await this.releaseClaimedBatchForTransportExit(session, 'transport:sdk_stream');
   }
   throw error;
   ```
   `isInvalidApiKeyError` is a module-level predicate in the file's existing
   `isSpawnFailure` style: the in-loop throw for the CLI's `authentication_failed`
   status line is tagged `{ code: INVALID_API_KEY_ERROR_CODE }` at the throw
   site, and the predicate checks that code — no message matching.

Both call one private helper, `releaseClaimedBatchForTransportExit(session,
reason)`: set the reason, log one warning, `abortController.abort()`
(best-effort), and `resetProcessingToPending` only when
`session.claimedMessageIds.length > 0`.

**Why this is the minimum.**
- `transport` is already in `PRESERVED_ABORT_CATEGORIES`, so
  `GeneratorExitHandler` keeps the session and `scheduleTransportResume`
  re-sends the buffered work on the existing transport backoff. No new
  category, no exit-handler or runner change.
- `!session.abortReason` is a reliable "nothing else named this exit" test:
  every `abortController.abort()` caller in `src` sets a reason first (quota
  guard, stall, `ResponseProcessor` ×5, idle, shutdown/`deleteSession`,
  recycle `overflow:*`, `provider_switch`). Quota, auth, overflow, idle and
  shutdown therefore keep theirs.
- `!isClassified(error)` keeps the catch point away from setup failures
  (`buildHardenedSdkOptions` and spawn errors throw classified
  `setup_required`), which the runner already pauses without finalizing via
  `skipGeneratorExitFinalization`; naming them `transport:` would have left a
  stale reason on the session that the setup path never consumes.
- `!isInvalidApiKeyError(error)` keeps upstream's behaviour for the one other
  throw inside the loop: a refused credential is left to the runner, which
  books it in observer health and finalizes. Pausing it as `transport:` would
  retry a bad key on the backoff for nothing and book nothing.
- The abort is load-bearing twice: it ends the feed (a pending
  `pacer.waitForAnswer` resolves `'aborted'`, not `'stalled'`, so the stall
  branch — with its paid-send record and its own reset — does not also run),
  and it is the only thing that wakes a generator parked in
  `SessionMessageBuffer.drain`.
- The reset is conditional so a batch the failed-turn branch already
  re-queued (`retriedAfterErrorResult`) is not reset twice.

**Deliberately not carried.**
- M11 (`GeneratorRunner`'s unclassified `else` branch booking and then
  finalizing). That is upstream's documented design ("anything still buffered
  is dropped here and recovered … by replaying the Claude Code transcript"),
  and with the two points above an SDK-originated failure never reaches it:
  it arrives as a `transport:` pause with the controller already aborted, so
  the runner's catch takes its "ignoring error after abort" exit. Only a
  provider that throws before its stream opens still lands in that branch.
  The runner-level probe stays `it.failing` to record the divergence.
- Acknowledgement timing (upstream confirms the batch on the text frame; the
  result frame only releases the feed). A design divergence, not a loss; its
  probe stays `it.failing`.

## Things a ClaudeProvider reader must know

- **`retriedAfterErrorResult` and `sdk_eof` compose.** A textless failed
  result re-queues the batch once and `pacer.answer()`s; if the SDK then ends
  with no result, the EOF point names `transport:sdk_eof` and aborts, and the
  conditional reset is a no-op because the re-queue already cleared the
  claims. `tests/worker/claude-provider-assistant-frames.test.ts ›
  re-queues the claimed batch when a textless turn ends on an SDK error
  (#3869)` exercises exactly this sequence (its scripted stream ends after the
  error result); its `resetProcessingToPending` stub now mirrors the real
  manager by clearing `session.claimedMessageIds`, and it asserts the named
  exit. Before that stub change the fake counted a second reset the real
  manager never makes.
- **Response stall.** `awaitObserverAnswer` sets `transport:response_stall`
  and aborts *before* the loop sees `pacer.hasStalled`, so the EOF point is
  skipped. In the other direction the new abort resolves a pending wait as
  `'aborted'`, so no stall is recorded. The stall path records a paid send
  for the unanswered prompt; the EOF/throw paths do not, although the prompt
  the child was answering may have been billed. A batch can therefore be
  re-sent once more than its paid budget would otherwise allow.
- **Observer health is not booked for these two exits.** With the controller
  aborted and the error unclassified, `GeneratorRunner`'s catch logs at debug
  and returns; the finally records an `aborted` telemetry outcome
  (`normalizeAbortReason` maps `transport:*` other than the deadline to
  `'none'`) and `handleGeneratorExit` schedules the transport resume. A
  persistently crashing SDK child now retries on the transport backoff
  (`transportResumeDelayMs`: LLM timeout × 2^(pauses−1), capped at
  `MAX_TRANSPORT_RESUME_BASE_DELAY_MS`, +25% jitter; on the cmem gateway
  bounded by `MAX_UNATTENDED_GATEWAY_RESUMES`) instead of being booked as an
  outage after one failure. That is the same treatment #4204 gives every
  other transport pause.
- **The `Invalid API key` throw inside the loop is excluded, not paused.**
  The CLI-status guard (`message.error === 'authentication_failed'`) throws a
  tagged `Error` that the catch point recognises and leaves alone, so its
  outcome is unchanged from upstream: the runner books it via
  `recordObserverFailure(provider, errorMsg)`, records an `error` telemetry
  outcome, and finalizes (no re-queue, no transport resume). Probe:
  `a generator that throws, seen from the runner › an Invalid API key status
  line is booked as the refused credential it is, not paused as transport`
  drives the real provider through `SessionRoutes` and captures, at booking
  time, that `abortReason` is still null and the claim still held. Its
  control (C-AUTH) drops the predicate from the guard: the runner then sees an
  unclassified error after an abort, books nothing, and the probe fails on
  `expect(booked).toHaveLength(1)` → `Received length: 0`.

## Controls

A probe that cannot fail proves nothing, so every probe was shown to flip
under a one-line mutation of `src`. For a probe that passed on plain upstream
the mutation removes the preservation and the probe must fail; for the five
probes the carried fix turned green, the control is the mirror — comment the
fix's call out and the probe must fail again. Each mutation was applied, the
probe run with `-t`, then the file restored and verified (`git checkout --`
plus `git diff --stat HEAD -- src` empty for M1–M11 on the unfixed tree;
byte-for-byte comparison against a saved copy for C-EOF/C-STREAM on the
fixed tree). Logs: scratchpad `controls*/`, not committed.

| # | Mutation (one line) | File | Probes | Result |
|---|---|---|---|---|
| M1 | Comment out `await this.sessionManager.resetProcessingToPending(…)` in the failed-turn branch | ClaudeProvider.ts | re-queues … once | fail: `timed out waiting for: re-sent observation` |
| M2 | `if (resultIsError && !retriedAfterErrorResult) {` → `if (resultIsError) {` | ClaudeProvider.ts | a second failure … | fail: `timed out: startSession after second failure` |
| M3 | Insert before `if (!turnDispatchedText) {`: `if (resultIsError && session.lastGeneratorSource === 'init') { session.abortController.abort(); break; }` | ClaudeProvider.ts | on the init turn … | fail: `timed out waiting for: first observation after failed init` |
| M4 (pre-fix) | The EOF release, inserted inline after the loop | ClaudeProvider.ts | the three EOF probes | all three flipped from failing to passing |
| M5 (pre-fix) | The catch release, inserted inline before the rethrow | ClaudeProvider.ts | the two throw probes | both flipped from failing to passing |
| C-EOF (post-fix mirror) | Comment out `await this.releaseClaimedBatchForTransportExit(session, 'transport:sdk_eof');` | ClaudeProvider.ts | the three EOF probes | 0 pass / 3 fail (`Received [1]`, exit `finalized 1`, `timed out … between-turn EOF`) |
| C-STREAM (post-fix mirror) | Comment out `… 'transport:sdk_stream');` | ClaudeProvider.ts | the two throw probes | 0 pass / 2 fail (`Received [1]` both) |
| C-AUTH (post-fix) | Drop `&& !isInvalidApiKeyError(error)` from the catch guard | ClaudeProvider.ts | an Invalid API key status line is booked … | 0 pass / 1 fail: `expect(booked).toHaveLength(1)` Expected 1 Received 0 |
| M6 | Comment out `signal.addEventListener('abort', onAbort, { once: true });` in `waitForMessage` | SessionMessageBuffer.ts | a session abort … between turns | fail: `timed out waiting for: generator released after abort` |
| M7 | `const outcome = await pacer.waitForAnswer(…)` → `const outcome = 'answered' as Awaited<ReturnType<typeof pacer.waitForAnswer>>;` | ClaudeProvider.ts | claims no later work … | fail: `expect(sdk().prompts.length).toBe(2)` Expected 2 Received 4 |
| M8 | Comment out `` session.abortReason = `quota:${decision.window ?? 'unknown'}`; `` | ClaudeProvider.ts | carries the actual quota-guard window … | fail: Expected `"quota:seven_day"` Received `undefined` |
| M9 | In `resetCarriedMemorySessionId`, add `this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);` (the #3628 regression) | ClaudeProvider.ts | starts a recycled generation … | fail: `SQLiteError: NOT NULL constraint failed: observations.memory_session_id` |
| M10 | Comment out `recordObserverFailure(provider, errorMsg);` in the unclassified `else` branch | GeneratorRunner.ts | books an unclassified stream failure … | fail: `toHaveBeenCalledWith('claude', 'transport exploded')` — not called |
| M11 (not carried) | Same line → `…; session.abortReason = 'transport:unclassified'; myController.abort();` | GeneratorRunner.ts | keeps the real buffered work after an unclassified … | flips (`marked as failing but it passed`) — kept as `it.failing` |

## Results (fixed state)

"Plain v13.32.0" is the probe body run as a plain `it` against untouched
upstream; "now" is the committed tree.

| Scenario (fork case it re-expresses) | Probe (`describe > it`) | Plain v13.32.0 | Now |
|---|---|---|---|
| Payload preserved through a failed result frame; re-sent, nothing acknowledged | `a failed result frame > re-queues the claimed batch once and re-sends it, with nothing acknowledged` | pass | pass |
| Batch that fails twice ends on a preserved reason (fork `stream:failed_result`) | `… > a second failure for the same batch ends the generation on a reason that preserves it` | pass (`output_retry:idle`) | pass |
| Unclaimed work preserved when init gets a failed result | `… > on the init turn leaves the unclaimed backlog intact and still sends it` | pass | pass |
| Payload preserved through unexpected EOF | `the SDK stream ends or breaks > clean EOF mid-batch releases the claim and leaves the session for the next generation` | **FAIL** | pass (`transport:sdk_eof`) |
| Payload preserved when the output iterator throws | `… > a thrown output iterator mid-batch surfaces the error and preserves the batch` | **FAIL** | pass (`transport:sdk_stream`) |
| Payload preserved when response processing throws | `… > a throw inside response processing surfaces the error and preserves the batch` | **FAIL** | pass (`transport:sdk_stream`) |
| Unclaimed work preserved when the SDK ends during init | `… > EOF during the init turn keeps the unclaimed backlog for the next generation` | **FAIL** | pass |
| Iterator waiting between turns released when SDK output ends | `… > EOF while the generator waits between turns releases the generator` | **FAIL** (hung) | pass |
| Iterator waiting between turns released on session abort | `… > a session abort while the generator waits between turns releases the generator` | pass | pass |
| No later work claimed before each successful result | `ordering and durable state > claims no later work before each successful result` | pass | pass |
| Batch acknowledged only once the result frame arrives | `… > acknowledges the batch only once the turn's result frame has arrived` | **FAIL** | `it.failing` — divergence kept |
| Weekly quota-guard reason carried out of the stream | `… > carries the actual quota-guard window out of the stream and keeps the claimed batch` | pass | pass |
| Recycled generation starts without nulling durable state | `… > starts a recycled generation without nulling durable observation and summary rows` | pass | pass |
| Thrown stream interruption is reported | `a generator that throws, seen from the runner > books an unclassified stream failure in observer health and does not retry it` | pass | pass |
| A refused API key stays a booked outage, not a transport pause (new; guards the exclusion) | `… > an Invalid API key status line is booked as the refused credential it is, not paused as transport` | pass (upstream behaviour, preserved) | pass |
| Buffered work preserved after a generic startup failure | `… > keeps the real buffered work after an unclassified stream failure` | **FAIL** | `it.failing` — divergence kept (see "Deliberately not carried") |

### The assertions each gap stopped on, pre-fix (for the record)

1. Clean EOF mid-batch: `expect(h.session.claimedMessageIds).toEqual([])` →
   `Received [1]`; end state `abortReason null`, exit → `finalized 1,
   sessionKept false, pending 0`.
2. Output iterator throws: same, run rejected `socket exploded`.
3. Throw inside response processing: same, run rejected `storage exploded`.
4. EOF during init: `expect(outcome).toEqual({ finalized: 0, sessionKept: true,
   pending: 1 })` → all three fields differed.
5. EOF between turns: `error: timed out waiting for: generator released after
   between-turn EOF [2043ms]`.
6. Acknowledgement timing: `expect(h.session.claimedMessageIds).toEqual([claimedId])`
   → `Received []`.
7. Runner-level unclassified failure: `expect(finalizeCalls()).toBe(0)` →
   `Received 1`.

## Disposition of the staged fork copies

`tests/worker/claude-provider-stream-order.test.ts.ours.test.ts` (15 cases,
14 failed on upstream — they mock `recycle-conversation.js` without
`openObserverGeneration`/`observesBarePrompts` and build the fork's harness):
every case is re-expressed above except
`keeps intentional idle and shutdown exits finalizing normally`, which is
covered by upstream's `tests/worker/generator-exit-preserves-work.test.ts`
(`still finalizes on an ordinary idle exit`). Removed.

`tests/worker/overflow-recycle-resume.test.ts.ours.test.ts` (9 cases):

| Fork case | Disposition |
|---|---|
| `starts a replacement generation without waiting for another captured tool call` | identical to upstream's — dropped |
| `does not resume once the recycle budget is exhausted` | identical — dropped |
| `does not resume on a quota pause — that one waits for the user` | identical — dropped |
| `does not resume on an auth pause` | identical — dropped |
| `preserves the session across a recycle instead of finalizing it` | identical — dropped |
| `preserves the quota guard decision through finalization, persisted health, and the user warning` | on plain v13.32.0 it failed with `Expected: "quota_guard" Received: "quota_exhausted"` (the fork-only `session.quotaPause` field has no upstream counterpart). The runner half was re-expressed by the sibling `candidate/v13.32.0-quota` branch as upstream `tests/worker/overflow-recycle-resume.test.ts` › `books a reserve-threshold abort as the guard pause it was, in the ledger and the cooldown`; the stream half is the quota-guard probe above. Dropped here. |
| `preserves a stream-failure pause without automatically retrying it` | fork reason `stream:failed_result` has no upstream category. Re-expressed as the double-failure probe; "without auto-resume" is superseded by upstream's transport backoff (#4204), which the carried fix now also relies on. |
| `preserves real buffered work without auto-retrying after a generic startup failure` | re-expressed as `keeps the real buffered work after an unclassified stream failure` (`it.failing`, divergence kept) |
| `reports a thrown stream interruption even though its controller is aborted` | re-expressed as `books an unclassified stream failure in observer health…` (upstream never aborts on a thrown stream error at the runner level) |

## Verification on the committed tree

- Probe file: 16 pass (14 plain, 2 `it.failing`).
- Every test file that imports or names `ClaudeProvider`, plus
  `overflow-recycle-resume.test.ts` and `generator-exit-preserves-work.test.ts`,
  one process each: all pass (`claude-provider-response-pacing` 24,
  `claude-provider-assistant-frames` 15 after the stub change,
  `overflow-recycle-resume` 8, `generator-exit-preserves-work` 7,
  `session-routes-cmem-gateway-fallback` 46, `provider-classifiers` 80,
  `claude-provider-error-classifier` 17, `claude-provider-resume` 10,
  `quota-cooldown-profile` 16, `telegram-wrapup-provider` 24,
  `session-routes-provider-switch` 12, `observer-bare-prompt` 10,
  `observer-image-strip-live-path` 10, `observer-generation-boundary` 6,
  `observer-measured-context` 6, `claude-provider-spawn-error` 6,
  `claude-setup-gate` 6, `fk-constraint-fix` 6, `wait-for-slot` 5,
  `session-identity-is-stable` 5, `claude-provider-discovery-backfill` 4).
- `npm run typecheck`: exit 0 (it excludes `tests/`; the probe file alone
  typechecks under the repo tsconfig with no in-file errors).
- Whole `bun test tests/worker`: 2113 pass / 5 skip / 2 fail against a
  2112 / 5 / 2 pre-fix baseline on the same candidate tip (+1 is the new
  probe); the two failures are the pre-existing
  `observation endpoint semantic row filters` 5-second timeouts.

Out of scope and untouched: anything under `src/` other than
`ClaudeProvider.ts`.
