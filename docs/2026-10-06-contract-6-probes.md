# Contract 6 probes against upstream v13.32.0

**Contract 6:** buffered work is preserved across stream failure and recycle.

The fork (`local/stable`) implemented this by serialising SDK turns through a
`TurnGate` in `ClaudeProvider` and naming three stream exits
(`stream:failed_result`, `stream:unexpected_eof`, `stream:interrupted`) that
`GeneratorExitHandler` treated as pause-and-preserve. Upstream replaced that
with `ObserverResponsePacer` (#4066), a once-only re-queue of a batch whose
turn failed before emitting text (`retriedAfterErrorResult` →
`resetProcessingToPending`), a `transport:response_stall` exit, and
`PRESERVED_ABORT_CATEGORIES` in `abort-reason.ts`. The owner ruled: do not
port `TurnGate`; probe the contract against upstream's mechanism and report.

Probe file: `tests/worker/claude-provider-work-preservation.test.ts`
(15 probes; 8 plain `it`, 7 `it.failing`). Harness style follows upstream's
`tests/worker/claude-provider-response-pacing.test.ts`: real `ClaudeProvider`,
`SessionManager` and `SessionMessageBuffer`; a fake SDK that pumps the prompt
iterator eagerly (as the real `query()` does) and can answer, fail a turn,
end, or throw from its output iterator; then the real `handleGeneratorExit`
on whatever `abortReason` the run left behind. Every probe asserts an
observable outcome (claims released, pending count, abort category, session
finalized or not, generator released within a timeout), never the mechanism.

Run: `CLAUDE_MEM_DATA_DIR=$(mktemp -d) bun test tests/worker/claude-provider-work-preservation.test.ts`

## Reading `it.failing`

A probe marked `it.failing` is a scenario upstream does **not** satisfy. bun
inverts the result, so the suite stays green while the gap is on record; if
upstream later closes the gap the probe turns red with "this test is marked
as failing but it passed", and should be flipped back to `it`. The section
"Scenarios upstream fails" below quotes the assertion each one stops on when
run as a plain `it`.

## Controls

A probe that cannot fail proves nothing, so every probe was shown to flip
under a one-line mutation of `src`. For a passing probe the mutation removes
the preservation and the probe must fail; for an `it.failing` probe the
mutation is the mirror — a one-line fix under which the contract holds, so
the probe's body passes and bun reports the inverted failure. Each mutation
was applied, the probe run with `-t`, then reverted with `git checkout --`
and `git diff --stat HEAD -- src` checked empty (all eleven: CLEAN). Logs:
scratchpad `controls/M1..M11.log` (not committed).

Three controls mutate a file other than `ClaudeProvider.ts` because the
preservation they remove lives there: M6 (`SessionMessageBuffer.ts`), M10 and
M11 (`GeneratorRunner.ts`).

| # | Mutation (one line) | File |
|---|---|---|
| M1 | Comment out `await this.sessionManager.resetProcessingToPending(session.sessionDbId);` in the failed-turn branch (`if (resultIsError && !retriedAfterErrorResult)`) | ClaudeProvider.ts |
| M2 | `if (resultIsError && !retriedAfterErrorResult) {` → `if (resultIsError) {` | ClaudeProvider.ts |
| M3 | Insert before `if (!turnDispatchedText) {`: `if (resultIsError && session.lastGeneratorSource === 'init') { session.abortController.abort(); break; }` | ClaudeProvider.ts |
| M4 | Insert after the `for await (const message of queryResult)` loop, before `} catch (error) {`: `if (!session.abortReason) { session.abortReason = 'transport:sdk_eof'; session.abortController.abort(); await this.sessionManager.resetProcessingToPending(session.sessionDbId); }` | ClaudeProvider.ts |
| M5 | Insert at the top of that `catch (error)`: `if (!session.abortReason) { session.abortReason = 'transport:sdk_stream'; session.abortController.abort(); await this.sessionManager.resetProcessingToPending(session.sessionDbId); }` | ClaudeProvider.ts |
| M6 | Comment out `signal.addEventListener('abort', onAbort, { once: true });` in `waitForMessage` | SessionMessageBuffer.ts |
| M7 | `const outcome = await pacer.waitForAnswer(answeredBeforeSend, session.abortController.signal, stallMs);` → `const outcome = 'answered' as Awaited<ReturnType<typeof pacer.waitForAnswer>>;` | ClaudeProvider.ts |
| M8 | Comment out `` session.abortReason = `quota:${decision.window ?? 'unknown'}`; `` | ClaudeProvider.ts |
| M9 | In `resetCarriedMemorySessionId`, add `this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);` before `session.memorySessionId = null;` (the #3628 regression) | ClaudeProvider.ts |
| M10 | Comment out `recordObserverFailure(provider, errorMsg);` in the unclassified `else` branch of the `.catch` | GeneratorRunner.ts |
| M11 | Same line → `recordObserverFailure(provider, errorMsg); session.abortReason = 'transport:unclassified'; myController.abort();` | GeneratorRunner.ts |

## Scenario → probe → result → control

"Unmutated" is the probe's body run as a plain `it` against untouched upstream.
"Control" is the observed result under the mutation.

| Scenario (fork case it re-expresses) | Probe (`describe > it`) | Unmutated | Control | Control result |
|---|---|---|---|---|
| Real buffered payload preserved through a failed result frame; re-sent, nothing acknowledged (`does not claim or acknowledge later work…`, `routes failed-turn quota and auth prose…`) | `a failed result frame > re-queues the claimed batch once and re-sends it, with nothing acknowledged` | pass | M1 | fail: `error: timed out waiting for: re-sent observation` |
| A batch that fails twice ends the generation on a preserved reason (fork: `stream:failed_result` pause) | `a failed result frame > a second failure for the same batch ends the generation on a reason that preserves it` | pass (`output_retry:idle`, exit keeps session, pending 2) | M2 | fail: `error: timed out: startSession after second failure` (endless re-queue) |
| Unclaimed buffered work preserved when the init turn gets a failed result (`preserves unclaimed real buffered work when init receives a failed result`) | `a failed result frame > on the init turn leaves the unclaimed backlog intact and still sends it` | pass | M3 | fail: `error: timed out waiting for: first observation after failed init` |
| Payload preserved through unexpected EOF (`…through unexpected EOF and generator exit`) | `the SDK stream ends or breaks > clean EOF mid-batch releases the claim and leaves the session for the next generation` | **FAIL** (see below) — marked `it.failing` | M4 | flips: `this test is marked as failing but it passed` |
| Payload preserved when the output iterator throws (`…when the SDK output iterator throws`) | `the SDK stream ends or breaks > a thrown output iterator mid-batch surfaces the error and preserves the batch` | **FAIL** — `it.failing` | M5 | flips: `marked as failing but it passed` |
| Payload preserved when response processing throws (`…when response processing throws`) | `the SDK stream ends or breaks > a throw inside response processing surfaces the error and preserves the batch` | **FAIL** — `it.failing` | M5 | flips: `marked as failing but it passed` |
| Unclaimed work preserved when the SDK ends during init (`…when the SDK ends during init`) | `the SDK stream ends or breaks > EOF during the init turn keeps the unclaimed backlog for the next generation` | **FAIL** — `it.failing` | M4 | flips: `marked as failing but it passed` |
| Iterator waiting between turns released when SDK output ends (`aborts a real message iterator waiting between turns when SDK output ends`) | `the SDK stream ends or breaks > EOF while the generator waits between turns releases the generator` | **FAIL** — `it.failing` | M4 | flips: `marked as failing but it passed` |
| Iterator waiting between turns released on session abort (`unblocks the eager input pump when the session is aborted before a result`) | `the SDK stream ends or breaks > a session abort while the generator waits between turns releases the generator` | pass | M6 | fail: `error: timed out waiting for: generator released after abort` |
| No later work claimed before each successful result (`does not claim or acknowledge later work before each successful result`, claim half) | `ordering and durable state > claims no later work before each successful result` | pass | M7 | fail: `expect(sdk().prompts.length).toBe(2)` Expected: 2 Received: 4 |
| Batch acknowledged only once the result frame arrives (same fork case, acknowledgement half) | `ordering and durable state > acknowledges the batch only once the turn's result frame has arrived` | **FAIL** (design divergence) — `it.failing` | none mechanical | see note below |
| Actual weekly quota-guard reason carried out of the stream (`carries the actual weekly quota guard reason out of the SDK stream`) | `ordering and durable state > carries the actual quota-guard window out of the stream and keeps the claimed batch` | pass (`quota:seven_day`; exit keeps session; next iterator re-yields the claimed id) | M8 | fail: `expect(h.session.abortReason).toBe('quota:seven_day')` Expected: "quota:seven_day" Received: undefined |
| Recycled generation starts without nulling durable observation state (`starts a recycled generation without nulling durable observation and summary foreign keys`) | `ordering and durable state > starts a recycled generation without nulling durable observation and summary rows` | pass | M9 | fail: `SQLiteError: NOT NULL constraint failed: observations.memory_session_id` thrown from `updateMemorySessionId` via `resetCarriedMemorySessionId`; `startSession` rejects |
| Thrown stream interruption is reported (`reports a thrown stream interruption even though its controller is aborted`) | `a generator that throws, seen from the runner > books an unclassified stream failure in observer health and does not retry it` | pass | M10 | fail: `expect(recordFailure).toHaveBeenCalledWith('claude', 'transport exploded')` — not called |
| Buffered work preserved after a generic startup/stream failure (`preserves real buffered work without auto-retrying after a generic startup failure`) | `a generator that throws, seen from the runner > keeps the real buffered work after an unclassified stream failure` | **FAIL** — `it.failing` | M11 | flips: `marked as failing but it passed` |

Note on the acknowledgement-timing probe: no one-line mutation makes upstream
defer `processAgentResponse` to the result frame, so its control is the
unmutated failure itself (the assertion is live: it received `[]` where the
contract expects the claimed id) and the claim-half probe above, which shows
the same harness distinguishing "claimed" from "acknowledged".

## Scenarios upstream fails (unmutated), with the assertion each stops on

The end-state for the three mid-batch cases was also captured with a
throwaway diagnostic (not committed) that logged the session after the run
and after `handleGeneratorExit`.

1. **Clean EOF mid-batch.** The `for await` over `query()` ends normally;
   `finally` calls `pacer.close()`, which releases the generator parked on the
   pacer, and the run resolves. Nothing releases the claim or names a reason.
   ```
   expect(h.session.claimedMessageIds).toEqual([]);
   error: expect(received).toEqual(expected)   - Expected [] / + Received [1]
   ```
   End state: `claimedMessageIds [1]`, `abortReason null`, `aborted false`,
   `pending 1`; `handleGeneratorExit(null)` → `finalized 1, sessionKept false,
   pending 0` (buffer disposed).

2. **Output iterator throws mid-batch.** `catch` rethrows (only spawn failures
   are classified); same end state as (1), run rejected `socket exploded`.
   ```
   expect(h.session.claimedMessageIds).toEqual([]);   - Expected [] / + Received [1]
   ```
   End state: `abortReason null`, exit → `finalized 1, sessionKept false, pending 0`.

3. **Throw inside response processing** (`confirmClaimedMessages` rejects on
   the skip sentinel). Same path and end state as (2), run rejected
   `storage exploded`.

4. **EOF during the init turn.** The unclaimed backlog is still buffered when
   the run resolves (`pending 1` passes), but `abortReason` is `null`, so:
   ```
   expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });
   error: expect(received).toEqual(expected)   - Expected - 3 / + Received + 3
   ```
   (all three fields differ: the exit handler finalized and disposed the buffer).

5. **EOF while the generator waits between turns.** `pacer.close()` wakes a
   generator parked on the pacer; this one is parked in
   `SessionMessageBuffer.drain → waitForMessage`, which listens for a message,
   the abort signal, or the 3-minute idle timeout. The run resolves, the
   generator does not.
   ```
   error: timed out waiting for: generator released after between-turn EOF   [2043ms]
   ```
   In production the generator would sit until `IDLE_TIMEOUT_MS` (3 min) after
   the session had already been finalized by (4)'s path. The fake SDK, like
   upstream's own `FakeSdk`, does not call `return()` on the prompt iterator;
   whether the real `query()` does on a clean exit was not verified here.

6. **Acknowledgement before the result frame.** Upstream processes and
   confirms the batch on the assistant text frame; the result frame only
   releases the feed (#4066: "The result frame is the one turn boundary").
   ```
   expect(h.session.claimedMessageIds).toEqual([claimedId]);
   error: expect(received).toEqual(expected)   - Expected [1] / + Received []
   ```
   This is a design divergence, not a loss: the text was stored or skipped
   before the acknowledgement, and prose refusals are handled by
   `ResponseProcessor` (`quota:`/`auth:`/`transport:observer_text`,
   `output_retry`). Recorded because the fork's contract held acknowledgement
   until the successful result and a later is_error result cannot re-queue.

7. **Unclassified generator failure, seen from the runner.** `GeneratorRunner`
   books it (`recordObserverFailure('claude', …)` — that probe passes) and then
   `handleGeneratorExit(null)` finalizes. This is upstream's documented design
   ("anything still buffered is dropped here and recovered, if needed, by
   replaying the Claude Code transcript").
   ```
   expect(finalizeCalls()).toBe(0);   Expected: 0  Received: 1
   ```

Cases (1)–(5) and (7) share one root cause: upstream's `ClaudeProvider` never
sets an `abortReason` or releases the claim when the SDK stream ends or
throws, so those exits reach `GeneratorExitHandler` as `null`, which is
"finalize and dispose". M4/M5 show that a `transport:` reason plus
`resetProcessingToPending` at those two points is enough for every probe to
hold; whether that is the right fix (versus relying on the transcript replay
upstream describes) is the owner's call. Nothing in `src` was changed.

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
| `preserves the quota guard decision through finalization, persisted health, and the user warning` | on plain v13.32.0 it failed with `Expected: "quota_guard" Received: "quota_exhausted"` (the fork-only `session.quotaPause` field has no upstream counterpart). The runner half was re-expressed by the sibling `candidate/v13.32.0-quota` branch as upstream `tests/worker/overflow-recycle-resume.test.ts` › `books a reserve-threshold abort as the guard pause it was, in the ledger and the cooldown` (rebuilds the guard decision from `globalRateLimitStore` in `GeneratorRunner`); the stream half is the quota-guard probe above. Dropped here. |
| `preserves a stream-failure pause without automatically retrying it` | fork reason `stream:failed_result` has no upstream category (`Expected: 0 Received: 1` finalize). Re-expressed as the double-failure probe; "without auto-resume" is superseded by upstream's transport backoff (#4204). |
| `preserves real buffered work without auto-retrying after a generic startup failure` | re-expressed as `keeps the real buffered work after an unclassified stream failure` (`it.failing`, gap 7) |
| `reports a thrown stream interruption even though its controller is aborted` | re-expressed as `books an unclassified stream failure in observer health…` (upstream never aborts on a thrown stream error, so the "despite aborted" clause does not arise) |

Out of scope and untouched: `tests/worker/rate-limit-store.test.ts.ours.test.ts`.
