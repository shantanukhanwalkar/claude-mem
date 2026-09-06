import { afterAll, describe, it, expect, mock } from 'bun:test';
import type { ActiveSession, PendingMessageWithId, SDKUserMessage } from '../../src/services/worker-types.js';

const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const realFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const realEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const realSettings = { ...(await import('../../src/shared/SettingsDefaultsManager.js')) };
const realPrompts = { ...(await import('../../src/sdk/prompts.js')) };
const realModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };
const realProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const realRecycle = { ...(await import('../../src/services/worker/session/recycle-conversation.js')) };
const realAgents = { ...(await import('../../src/services/worker/agents/index.js')) };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

class EagerFakeQuery implements AsyncIterableIterator<any> {
  readonly output = new AsyncQueue<any>();
  readonly prompts: SDKUserMessage[] = [];
  readonly inputDone: Promise<void>;
  private promptWaiters: Array<() => void> = [];

  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    this.inputDone = this.pumpInput(prompt);
  }

  private async pumpInput(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      this.prompts.push(message);
      for (const waiter of this.promptWaiters.splice(0)) waiter();
    }
  }

  async waitForPrompts(count: number): Promise<void> {
    while (this.prompts.length < count) {
      await new Promise<void>(resolve => this.promptWaiters.push(resolve));
    }
  }

  next(): Promise<IteratorResult<any>> {
    return this.output.next();
  }

  return(): Promise<IteratorResult<any>> {
    return this.output.return();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<any> {
    return this;
  }
}

let activeQuery: EagerFakeQuery | undefined;
const processed: Array<{ text: string; source?: string; claimed: number[] }> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    activeQuery = new EagerFakeQuery(prompt);
    return activeQuery;
  },
}));

mock.module('../../src/shared/find-claude-executable.js', () => ({
  findClaudeExecutable: () => '/mock/claude',
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  buildIsolatedEnvWithFreshOAuth: async () => ({}),
  getAuthMethodDescription: () => 'cli',
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_MODEL: 'claude-test',
      CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '1',
      CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS: '1000000',
    }),
  },
}));

mock.module('../../src/sdk/prompts.js', () => ({
  OBS_PROMPT_FIELD_MAX_CHARS: 16_000,
  buildInitPrompt: () => 'INIT',
  buildContinuationPrompt: () => 'CONTINUATION',
  buildObservationPrompt: ({ tool_name }: { tool_name: string }) => `OBSERVATION:${tool_name}`,
  buildSummaryPrompt: () => 'SUMMARY',
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: { getInstance: () => ({ getActiveMode: () => ({}) }) },
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  waitForSlot: async () => ({ release: () => {} }),
  createSdkSpawnFactory: () => () => { throw new Error('fake SDK must not spawn'); },
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/services/worker/session/recycle-conversation.js', () => ({
  loadSessionStartContext: async () => '',
  recycleObserverConversation: async () => {},
}));

mock.module('../../src/services/worker/agents/index.js', () => ({
  snapshotResponseContext: (session: ActiveSession) => ({
    source: session.lastGeneratorSource,
    project: session.project,
    promptNumber: session.lastPromptNumber,
    pendingAgentId: session.pendingAgentId ?? null,
    pendingAgentType: session.pendingAgentType ?? null,
  }),
  processAgentResponse: async (text: string, session: ActiveSession, ...args: any[]) => {
    const context = args[8] as { source?: string } | undefined;
    processed.push({ text, source: context?.source, claimed: [...session.claimedMessageIds] });
    if (/session limit|authentication failed/i.test(text)) {
      await args[1].resetProcessingToPending(session.sessionDbId);
    } else if (context?.source !== 'init') {
      session.claimedMessageIds = [];
    }
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => realFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => realEnvManager);
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettings);
  mock.module('../../src/sdk/prompts.js', () => realPrompts);
  mock.module('../../src/services/domain/ModeManager.js', () => realModeManager);
  mock.module('../../src/supervisor/process-registry.js', () => realProcessRegistry);
  mock.module('../../src/services/worker/session/recycle-conversation.js', () => realRecycle);
  mock.module('../../src/services/worker/agents/index.js', () => realAgents);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { SessionManager } = await import('../../src/services/worker/SessionManager.js');
const { handleGeneratorExit } = await import('../../src/services/worker/session/GeneratorExitHandler.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-42',
    memorySessionId: null,
    project: 'project-a',
    platformSource: 'claude',
    userPrompt: 'Remember only completed tool work.',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
    pendingAgentId: null,
    pendingAgentType: null,
  };
}

function makeHarness(messages: PendingMessageWithId[]) {
  const session = makeSession();
  let resetCalls = 0;
  const sessionManager = {
    getMessageIterator: async function* () {
      for (const message of messages) {
        session.claimedMessageIds.push(message._persistentId);
        session.earliestPendingTimestamp ??= message._originalTimestamp;
        yield message;
      }
    },
    resetProcessingToPending: async () => {
      resetCalls += 1;
      session.claimedMessageIds = [];
      return 1;
    },
  };
  const sessionStore = {
    updateMemorySessionId: () => {},
    ensureMemorySessionIdRegistered: (_id: number, memorySessionId: string) => {
      session.memorySessionId = memorySessionId;
    },
    getSessionById: () => ({ memory_session_id: session.memorySessionId }),
  };
  const dbManager = { getSessionStore: () => sessionStore };
  const provider = new ClaudeProvider(dbManager as any, sessionManager as any);
  return { session, provider, getResetCalls: () => resetCalls };
}

async function makeRealBufferHarness(sessionDbId: number, queueTool = true) {
  let memorySessionId: string | null = null;
  const sessionStore = {
    getPromptNumberFromUserPrompts: () => 1,
    updateMemorySessionId: (_id: number, value: string | null) => { memorySessionId = value; },
    ensureMemorySessionIdRegistered: (_id: number, value: string) => { memorySessionId = value; },
    getSessionById: () => ({ memory_session_id: memorySessionId }),
  };
  const dbManager = {
    getSessionById: () => ({
      content_session_id: `content-${sessionDbId}`,
      memory_session_id: memorySessionId,
      project: 'project-a',
      platform_source: 'claude',
      user_prompt: 'Remember only completed tool work.',
    }),
    getSessionStore: () => sessionStore,
  };
  const sessionManager = new SessionManager(dbManager as any);
  const session = sessionManager.initializeSession(sessionDbId, 'Remember only completed tool work.', 1);
  session.currentProvider = 'claude';
  if (queueTool) {
    await sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: { file_path: 'retained.ts' },
      tool_response: 'retained payload',
      prompt_number: 2,
      toolUseId: `tool-${sessionDbId}`,
    });
  }
  const provider = new ClaudeProvider(dbManager as any, sessionManager);
  return { session, sessionManager, provider };
}

function assistant(text: string) {
  return {
    type: 'assistant',
    session_id: 'memory-42',
    message: { content: text ? [{ type: 'text', text }] : [], usage: {} },
  };
}

function success(result: string) {
  return {
    type: 'result', subtype: 'success', is_error: false, result,
    session_id: 'memory-42', usage: {}, total_cost_usd: 0,
  };
}

function failure(error: string) {
  return {
    type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error],
    session_id: 'memory-42', usage: {}, total_cost_usd: 0,
  };
}

function syntheticFailure(error: string) {
  return {
    type: 'result', subtype: 'success', is_error: true, result: error,
    session_id: 'memory-42', usage: {}, total_cost_usd: 0,
  };
}

function pendingObservation(id: number, file: string): PendingMessageWithId {
  return {
    type: 'observation', tool_name: 'Read', tool_input: { file_path: file },
    tool_response: file, prompt_number: 2, _persistentId: id, _originalTimestamp: id * 100,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function within<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
  ]);
}

describe('ClaudeProvider streaming turn ordering', () => {
  it('does not claim or acknowledge later work before each successful result', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const messages: PendingMessageWithId[] = [
      {
        type: 'observation', tool_name: 'Read', tool_input: { file_path: 'a.ts' },
        tool_response: 'A', prompt_number: 2, _persistentId: 1, _originalTimestamp: 100,
      },
      {
        type: 'observation', tool_name: 'Read', tool_input: { file_path: 'b.ts' },
        tool_response: 'B', prompt_number: 2, _persistentId: 2, _originalTimestamp: 200,
      },
    ];
    const { session, provider, getResetCalls } = makeHarness(messages);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    await settle();
    expect(activeQuery.prompts).toHaveLength(1);
    expect(session.claimedMessageIds).toEqual([]);

    activeQuery.output.push(assistant(''));
    await settle();
    expect(processed).toEqual([]);
    expect(session.claimedMessageIds).toEqual([]);

    activeQuery.output.push(success(''));
    await activeQuery.waitForPrompts(2);
    await settle();
    expect(processed.map(item => item.source)).toEqual(['init']);
    expect(session.claimedMessageIds).toEqual([1]);

    activeQuery.output.push(assistant('<skip_observation />'));
    await settle();
    expect(processed).toHaveLength(1);
    expect(session.claimedMessageIds).toEqual([1]);

    activeQuery.output.push(success('<skip_observation />'));
    await activeQuery.waitForPrompts(3);
    await settle();
    expect(processed[1]).toEqual({ text: '<skip_observation />', source: 'ingest', claimed: [1] });
    expect(session.claimedMessageIds).toEqual([2]);

    activeQuery.output.push(assistant('<observation><title>partial</title></observation>'));
    activeQuery.output.push(syntheticFailure('upstream failed'));
    await within(run);
    await within(activeQuery.inputDone);

    expect(processed).toHaveLength(2);
    expect(getResetCalls()).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
  });

  it('routes failed-turn quota and auth prose through refusal handling without claiming later work', async () => {
    for (const result of [
      failure("You've hit your session limit; resets later"),
      syntheticFailure('Authentication failed; run /login to continue'),
    ]) {
      processed.length = 0;
      activeQuery = undefined;
      const { session, provider, getResetCalls } = makeHarness([
        pendingObservation(1, 'a.ts'),
        pendingObservation(2, 'b.ts'),
      ]);
      const run = provider.startSession(session);

      while (!activeQuery) await settle();
      await activeQuery.waitForPrompts(1);
      activeQuery.output.push(success(''));
      await activeQuery.waitForPrompts(2);
      activeQuery.output.push(result);
      await within(run);
      await within(activeQuery.inputDone);

      expect(activeQuery.prompts).toHaveLength(2);
      expect(processed[1]).toMatchObject({ source: 'ingest', claimed: [1] });
      expect(getResetCalls()).toBe(1);
      expect(session.claimedMessageIds).toEqual([]);
    }
  });

  it('unblocks the eager input pump when the session is aborted before a result', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, provider, getResetCalls } = makeHarness([pendingObservation(1, 'a.ts')]);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(success(''));
    await activeQuery.waitForPrompts(2);
    session.abortReason = 'shutdown';
    session.abortController.abort();

    await within(activeQuery.inputDone);
    activeQuery.output.close();
    await within(run);
    expect(activeQuery.prompts).toHaveLength(2);
    expect(getResetCalls()).toBe(1);
    expect(processed.map(item => item.source)).toEqual(['init']);
    expect(session.abortReason).toBe('shutdown');
  });

  it('unblocks the eager input pump when the SDK output ends before a result', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, provider, getResetCalls } = makeHarness([pendingObservation(1, 'a.ts')]);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(success(''));
    await activeQuery.waitForPrompts(2);
    activeQuery.output.close();

    await within(run);
    await within(activeQuery.inputDone);
    expect(activeQuery.prompts).toHaveLength(2);
    expect(getResetCalls()).toBe(1);
    expect(processed.map(item => item.source)).toEqual(['init']);
  });

  it('preserves the real buffered tool payload through a failed result and generator exit', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, sessionManager, provider } = await makeRealBufferHarness(81);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(success(''));
    await activeQuery.waitForPrompts(2);
    activeQuery.output.push(failure('upstream failed'));
    await within(run);

    expect(session.abortReason).toBe('stream:failed_result');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(sessionManager.getMessageBuffer().getPendingCount(81)).toBe(1);
    expect(sessionManager.getClaimedMessages(81)).toEqual([]);

    let finalized = 0;
    await handleGeneratorExit(session, session.abortReason, {
      sessionManager,
      completionHandler: { finalizeSession: async () => { finalized += 1; } } as any,
    });

    expect(finalized).toBe(0);
    expect(sessionManager.getSession(81)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(81)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('preserves the real buffered tool payload through unexpected EOF and generator exit', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, sessionManager, provider } = await makeRealBufferHarness(82);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(success(''));
    await activeQuery.waitForPrompts(2);
    activeQuery.output.close();
    await within(run);
    await within(activeQuery.inputDone);

    expect(session.abortReason).toBe('stream:unexpected_eof');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(sessionManager.getMessageBuffer().getPendingCount(82)).toBe(1);
    expect(sessionManager.getClaimedMessages(82)).toEqual([]);

    let finalized = 0;
    await handleGeneratorExit(session, session.abortReason, {
      sessionManager,
      completionHandler: { finalizeSession: async () => { finalized += 1; } } as any,
    });

    expect(finalized).toBe(0);
    expect(sessionManager.getSession(82)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(82)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('preserves unclaimed real buffered work when init receives a failed result', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, sessionManager, provider } = await makeRealBufferHarness(85);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(failure('init failed'));
    await within(run);
    await within(activeQuery.inputDone);

    expect(activeQuery.prompts).toHaveLength(1);
    expect(session.abortReason).toBe('stream:failed_result');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(sessionManager.getMessageBuffer().getPendingCount(85)).toBe(1);

    let finalized = 0;
    await handleGeneratorExit(session, session.abortReason, {
      sessionManager,
      completionHandler: { finalizeSession: async () => { finalized += 1; } } as any,
    });
    expect(finalized).toBe(0);
    expect(sessionManager.getSession(85)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(85)).toBe(1);
  });

  it('preserves unclaimed real buffered work when the SDK ends during init', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, sessionManager, provider } = await makeRealBufferHarness(86);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.close();
    await within(run);
    await within(activeQuery.inputDone);

    expect(activeQuery.prompts).toHaveLength(1);
    expect(session.abortReason).toBe('stream:unexpected_eof');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(sessionManager.getMessageBuffer().getPendingCount(86)).toBe(1);

    let finalized = 0;
    await handleGeneratorExit(session, session.abortReason, {
      sessionManager,
      completionHandler: { finalizeSession: async () => { finalized += 1; } } as any,
    });
    expect(finalized).toBe(0);
    expect(sessionManager.getSession(86)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(86)).toBe(1);
  });

  it('aborts a real message iterator waiting between turns when SDK output ends', async () => {
    processed.length = 0;
    activeQuery = undefined;
    const { session, sessionManager, provider } = await makeRealBufferHarness(87, false);
    const run = provider.startSession(session);

    while (!activeQuery) await settle();
    await activeQuery.waitForPrompts(1);
    activeQuery.output.push(success(''));
    await settle();
    activeQuery.output.close();

    await within(run);
    await within(activeQuery.inputDone);
    expect(session.abortReason).toBe('stream:unexpected_eof');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(sessionManager.getSession(87)).toBe(session);
  });

  it('keeps intentional idle and shutdown exits finalizing normally', async () => {
    for (const [sessionDbId, reason] of [[83, 'idle'], [84, 'shutdown']] as const) {
      const { session, sessionManager } = await makeRealBufferHarness(sessionDbId);
      session.abortReason = reason;
      session.abortController.abort();
      let finalized = 0;

      await handleGeneratorExit(session, reason, {
        sessionManager,
        completionHandler: { finalizeSession: async () => { finalized += 1; } } as any,
      });

      expect(finalized).toBe(1);
      expect(sessionManager.getSession(sessionDbId)).toBeUndefined();
      expect(sessionManager.getMessageBuffer().getPendingCount(sessionDbId)).toBe(0);
    }
  });
});
