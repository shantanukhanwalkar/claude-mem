import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { RateLimitStore, shouldAbortForQuota } from '../../src/services/worker/RateLimitStore.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import * as observerHealth from '../../src/shared/observer-health.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 77,
    contentSessionId: 'content-77',
    memorySessionId: 'memory-77',
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 3,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

/** Let the deferred resume timer (setTimeout 0) run. */
function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

function buildRoutes(session: ActiveSession, startSession: () => Promise<void>) {
  let finalizeCalls = 0;
  let removed = 0;
  let active: ActiveSession | undefined = session;

  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => {
      removed += 1;
      active = undefined;
    },
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );

  return { routes, stats: () => ({ finalizeCalls, removed, active }) };
}

async function buildRoutesWithRealBuffer(sessionDbId: number, startSession: () => Promise<void>) {
  const dbManager = {
    getSessionById: () => ({
      content_session_id: `content-${sessionDbId}`,
      memory_session_id: null,
      project: 'project',
      platform_source: 'claude',
      user_prompt: 'prompt',
      observed_model: null,
      observed_billing: null,
    }),
    getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
  };
  const sessionManager = new SessionManager(dbManager as any);
  const session = sessionManager.initializeSession(sessionDbId, 'prompt', 1);
  await sessionManager.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: { file_path: 'queued.ts' },
    tool_response: 'queued work',
    prompt_number: 2,
    toolUseId: `tool-${sessionDbId}`,
  });
  let finalizeCalls = 0;
  const routes = new SessionRoutes(
    sessionManager,
    dbManager as any,
    { startSession } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );

  return { routes, session, sessionManager, finalizeCalls: () => finalizeCalls };
}

describe('observer resumes itself after recycling its conversation (#3800)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  it('starts a replacement generation without waiting for another captured tool call', async () => {
    // The failure this guards: recycling resets the claimed batch to pending and
    // aborts, but the documented restart path needs a LATER ingest. On the last
    // observation of a session no later ingest arrives, so that work would sit
    // in the pending buffer forever and never be recorded.
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      // The replacement generation stays alive.
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(2);
  });

  it('does not resume once the recycle budget is exhausted', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'overflow:exhausted';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Exactly one start: giving up must stay given up, or the pause is not a pause.
    expect(starts).toBe(1);
  });

  it('does not resume on a quota pause — that one waits for the user', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'quota:weekly';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('preserves the quota guard decision through finalization, persisted health, and the user warning', async () => {
    const session = makeSession();
    const store = new RateLimitStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.95 });
    const decision = shouldAbortForQuota('cli', store);
    expect(decision.abort).toBe(true);
    const { routes, stats } = buildRoutes(session, async () => {
      session.abortReason = `quota:${decision.window}`;
      session.quotaPause = decision.pause;
      session.abortController.abort();
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    const health = observerHealth.readObserverHealth()!;
    expect(health.lastErrorKind).toBe('quota_guard');
    expect(health.lastErrorMessage).toContain('95% pause threshold');
    expect(observerHealth.renderObserverHealthWarning(health)).toContain('paused to preserve');
    expect(getQuotaCooldown('claude')?.message).toBe(health.lastErrorMessage);
    expect(getQuotaCooldown('claude')?.window).toBe('seven_day');
    expect(session.quotaPause).toBeNull();
    expect(session.abortReason).toBeNull();
    expect(stats().finalizeCalls).toBe(0);
    expect(stats().removed).toBe(0);
  });

  it('does not resume on an auth pause', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'auth:observer_text';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('preserves a stream-failure pause without automatically retrying it', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes, stats } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'stream:failed_result';
      session.abortController.abort();
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
    expect(stats().finalizeCalls).toBe(0);
    expect(stats().removed).toBe(0);
    expect(stats().active).toBe(session);
  });

  it('preserves real buffered work without auto-retrying after a generic startup failure', async () => {
    let starts = 0;
    const recordFailure = spyOn(observerHealth, 'recordObserverFailure').mockImplementation(() => {});
    const { routes, session, sessionManager, finalizeCalls } = await buildRoutesWithRealBuffer(78, async () => {
      starts += 1;
      throw new Error('startup exploded');
    });

    try {
      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await nextTick();

      expect(recordFailure).toHaveBeenCalledWith('claude', 'startup exploded');
      expect(starts).toBe(1);
      expect(finalizeCalls()).toBe(0);
      expect(sessionManager.getSession(session.sessionDbId)).toBe(session);
      expect(sessionManager.getMessageBuffer().getPendingCount(session.sessionDbId)).toBe(1);
    } finally {
      recordFailure.mockRestore();
    }
  });

  it('reports a thrown stream interruption even though its controller is aborted', async () => {
    const session = makeSession();
    let starts = 0;
    const recordFailure = spyOn(observerHealth, 'recordObserverFailure').mockImplementation(() => {});

    try {
      const { routes, stats } = buildRoutes(session, async () => {
        starts += 1;
        session.abortReason = 'stream:interrupted';
        session.abortController.abort();
        throw new Error('transport exploded');
      });

      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await nextTick();

      expect(starts).toBe(1);
      expect(recordFailure).toHaveBeenCalledWith('claude', 'transport exploded');
      expect(stats().finalizeCalls).toBe(0);
      expect(stats().removed).toBe(0);
      expect(stats().active).toBe(session);
    } finally {
      recordFailure.mockRestore();
    }
  });

  it('preserves the session across a recycle instead of finalizing it', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes, stats } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Finalizing would drop the batch the recycle just reset to pending.
    expect(stats().finalizeCalls).toBe(0);
    expect(stats().removed).toBe(0);
    expect(stats().active).toBe(session);
  });
});
