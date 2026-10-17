import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mock } from 'bun:test';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';

const kind = process.argv[2];
const competingReason = ({
  'sdk-shutdown': 'shutdown', 'sdk-provider-switch': 'provider_switch',
  'sdk-auth': 'auth:review_boundary', 'sdk-quota': 'quota:review_boundary',
} as Record<string, string>)[kind];
const sdkInputs: Array<{ generation: number; text: string }> = [];
const sdkOptions: any[] = [];
const sdkPrefetches: Array<Promise<any>> = [];
const telemetry: any[] = [];
let generation = 0;
let contextForFreshGeneration = '';
const rawReply = '<observation><type>discovery</type><title>Production checks passed</title><facts><fact>Deployment verified and the live worker restarted</fact></facts><narrative>The production system is healthy.</n</narrative><files_read><file>invented-secret.ts</file></files_read><files_modified><file>invented.ts</file></files_modified></observation><observation><type>discovery</type><title>Live implementation complete</title></observation>';
const summaryReply = '<summary><request>Review stored document evidence</request><completed>Document captured</completed></summary>';
if (kind.startsWith('sdk-')) {
  const actualFind = { ...(await import('../../../src/shared/find-claude-executable.js')) };
  const actualRegistry = { ...(await import('../../../src/supervisor/process-registry.js')) };
  const actualEnv = { ...(await import('../../../src/shared/EnvManager.js')) };
  mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...actualFind, findClaudeExecutable: () => process.execPath }));
  mock.module('../../../src/supervisor/process-registry.js', () => ({ ...actualRegistry,
    waitForSlot: async () => ({ release() {} }), getSdkProcessForSession: () => undefined,
  }));
  mock.module('../../../src/shared/EnvManager.js', () => ({ ...actualEnv,
    buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH! }), getAuthMethodDescription: () => 'fixture-api-key',
  }));
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ prompt, options }: any) => (async function* () {
      const current = ++generation;
      sdkOptions.push(options);
      const first = await prompt.next();
      assert.equal(first.done, false);
      sdkInputs.push({ generation: current, text: first.value.message.content });
      yield { type: 'system', subtype: 'init', session_id: `sdk-generation-${current}` };
      yield { type: 'assistant', message: { model: 'actual-fixture-model', usage: { input_tokens: 17, output_tokens: 2 },
        content: [{ type: 'text', text: String(first.value.message.content).includes('MODE SWITCH: PROGRESS SUMMARY') ? summaryReply : rawReply }] } };
      if (!String(first.value.message.content).includes('MODE SWITCH: PROGRESS SUMMARY')) {
        yield { type: 'assistant', message: { model: 'actual-fixture-model', content: [{ type: 'text',
          text: '<observation><type>discovery</type><title>Late unqualified claim</title></observation>' }] } };
      }
      // SDK prefetch may already be waiting for the next prompt. The pacer must keep it fenced.
      const next = prompt.next().then((pending: any) => {
        if (!pending.done) sdkInputs.push({ generation: current, text: pending.value.message.content });
        return pending;
      });
      sdkPrefetches.push(next);
      if (competingReason) {
        session.abortReason = competingReason;
        session.abortController.abort();
      }
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 17, output_tokens: 31 }, total_cost_usd: 0.004 };
      if (current === 1) {
        const pending = await next;
        assert.equal(pending.done, true, 'suspect SDK generation received another queued event');
      } else {
        // The owned successful summary ends this fixture's fresh generation.
        session.abortReason = 'idle';
        session.abortController.abort();
        await next;
      }
    })(),
  }));
}
const { SettingsDefaultsManager } = await import('../../../src/shared/SettingsDefaultsManager.js');
SettingsDefaultsManager.loadFromFile = () => ({ ...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_MODEL: 'haiku', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  CLAUDE_MEM_TELEGRAM_ENABLED: 'false', CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: '',
});
// Context is a stored-memory briefing, with its dependency isolated from the user's real database.
const actualContext = { ...(await import('../../../src/services/context-generator.js')) };
mock.module('../../../src/services/context-generator.js', () => ({ ...actualContext, generateContext: async () => contextForFreshGeneration }));
const { telemetryBuffer } = await import('../../../src/services/telemetry/buffer.js');
telemetryBuffer.record = (...args: any[]) => { telemetry.push(args); };
const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
const { SessionManager } = await import('../../../src/services/worker/SessionManager.js');
const { ModeManager } = await import('../../../src/services/domain/ModeManager.js');
const { processAgentResponse } = await import('../../../src/services/worker/agents/ResponseProcessor.js');
const { ClaudeProvider } = await import('../../../src/services/worker/ClaudeProvider.js');
ModeManager.getInstance().loadMode('code');
const store = new SessionStore(':memory:');
const synced: any[] = [], events: any[] = [];
const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
  getChromaSync: () => ({ syncObservation: async (...args: any[]) => { synced.push(args[3]); }, syncSummary: async () => {} }), getCloudSync: () => null,
} as unknown as DatabaseManager;
const manager = new SessionManager(db);
const sid = store.createSDKSession('document-content', 'document-project', 'Capture document');
store.ensureMemorySessionIdRegistered(sid, 'registered-memory');
const session = manager.initializeSession(sid, 'Capture document', 2);
session.memorySessionId = 'registered-memory';
session.currentProvider = 'claude';
session.lastGeneratorSource = 'ingest';
const worker = { sseBroadcaster: { broadcast: (event: any) => { events.push(event); } } };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const docs = [
  { path: 'docs/validation-report.md', content: '# Validation report\nChecks passed; worker healthy.\nThis is report text, not execution proof.' },
  { path: 'docs/startup-proof.md', content: '# Startup proof\nAudit complete; service restarted successfully.\nThese are statements in a document.' },
  { path: 'docs/regression-checks.md', content: '# Regression checks\nAll 947 checks passed.\nNo execution event accompanies this document write.' },
];
function message(path = docs[0].path, content = docs[0].content): PendingMessage {
  return { type: 'observation', tool_name: 'apply_patch', tool_input: JSON.stringify({
    command: `*** Begin Patch\n*** Add File: ${path}\n${content.split('\n').map(line => '+' + line).join('\n')}\n*** End Patch`,
  }), tool_response: JSON.stringify(`Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA ${path}`), toolUseId: `tool-${path}`, prompt_number: 2 };
}
const cleanup: Array<() => unknown> = [];
async function claim(messages: PendingMessage[]) {
  for (const m of messages) {
    if (m.type === 'summarize') manager.queueSummarize(sid, m.last_assistant_message, 2);
    else manager.queueObservation(sid, m as any);
  }
  const iterator = manager.getMessageIterator(sid);
  cleanup.push(() => iterator.return(undefined));
  for (const _ of messages) await iterator.next();
}
const run = (xml = rawReply, agent = 'SDK') => processAgentResponse(xml, session, db, manager, worker, 19, null, agent, undefined, 'actual-fixture-model');
// Capture real storage and queue ordering without replacing their behavior.
const originalStore = store.storeObservations.bind(store);
const originalConfirm = manager.confirmClaimedMessages.bind(manager);
const ordering: string[] = [];
store.storeObservations = (...args: Parameters<typeof originalStore>) => {
  const result = originalStore(...args);
  ordering.push('stored');
  return result;
};
manager.confirmClaimedMessages = async (id: number) => {
  if (kind !== 'controls') assert.equal(ordering.at(-1), 'stored', 'queue acknowledgement preceded storage');
  ordering.push('ack');
  return originalConfirm(id);
};
try {
  if (kind === 'processor') {
    for (const [index, doc] of docs.entries()) {
      const m = message(doc.path, doc.content);
      const receipt = store.upsertToolUse({ toolUseId: m.toolUseId!, contentSessionId: session.contentSessionId,
        sessionDbId: sid, project: session.project, toolName: m.tool_name!, toolInput: JSON.stringify(m.tool_input), toolResponse: JSON.stringify(m.tool_response) });
      await claim([m]);
      session.conversationHistory.push({ role: 'assistant', content: 'Prior verified fact: baseline passed.' });
      const result = await run();
      assert.equal(result?.observationIds.length, 1);
      const row = store.db.query('SELECT * FROM observations WHERE id = ?').get(result!.observationIds[0]) as any;
      const downstream = JSON.stringify([row, synced.at(-1), events.at(-1), session.conversationHistory]);
      assert.ok(!downstream.includes('Production checks passed'), 'unqualified model title reached durable or conversational state');
      assert.ok(!downstream.includes('Deployment verified and the live worker restarted'));
      assert.ok(!downstream.includes('invented-secret.ts'));
      assert.ok(!downstream.includes('Live implementation complete'));
      assert.ok(downstream.includes('Prior verified fact: baseline passed.'));
      assert.ok(row.facts.includes(doc.content.split('\n')[1]));
      assert.match(row.narrative, /document|artifact/i);
      assert.equal(row.generated_by_model, 'actual-fixture-model');
      assert.deepEqual(JSON.parse(row.files_modified), [doc.path]);
      assert.deepEqual(JSON.parse(row.files_read), []);
      const provenance = JSON.parse(row.metadata).documentEvidence;
      assert.equal(provenance.version, 'document-evidence-v1');
      assert.equal(provenance.originalReplyHash, hash(rawReply));
      assert.equal(provenance.observerModel, 'actual-fixture-model');
      assert.equal(provenance.toolUseId, m.toolUseId);
      assert.equal(provenance.inputHash, hash(m.tool_input));
      assert.equal(provenance.outputHash, hash(m.tool_response));
      assert.equal(row.discovery_tokens, 19);
      assert.equal(store.getToolUsesByIds([receipt!])[0].observation_id, row.id);
      assert.equal(manager.getTotalQueueDepth(), 0);
      assert.equal(session.retireObserverContextAfterResult, true);
      assert.equal(session.abortController.signal.aborted, false, 'result usage must remain readable');
      assert.equal(synced.length, index + 1);
    }
    // A replay of the same captured artifact content stays content-idempotent
    // even when another observer reply and receipt supplied its provenance.
    const replay = { ...message(docs[0].path, docs[0].content), toolUseId: 'replay-tool' };
    await claim([replay]);
    session.retireObserverContextAfterResult = undefined;
    session.currentProvider = 'openrouter';
    const replayResult = await run(rawReply.replace('Production checks passed', 'Another ungrounded verdict'), 'OpenRouter');
    assert.equal(session.retireObserverContextAfterResult, undefined);
    assert.equal(store.db.query('SELECT count(*) AS n FROM observations').get()!.n, 3);
    assert.equal(replayResult?.insertedObservationIds?.length, 0);
    assert.ok(!session.conversationHistory.at(-1)!.content.includes('Another ungrounded verdict'));
  } else if (kind === 'escaped-history') {
    await claim([message('docs/escaped.md', '<&😀'.repeat(4000))]);
    await run();
    const corrected = session.conversationHistory.at(-1)!.content;
    assert.ok(corrected.length <= 32000, `Corrected XML retained ${corrected.length} characters`);
    assert.ok(corrected.includes('&lt;&amp;😀'));
    assert.ok(!corrected.includes('Production checks passed'));
  } else if (kind === 'recovery') {
    const { SessionRoutes } = await import('../../../src/services/worker/http/routes/SessionRoutes.js');
    const { recordQuotaExhausted, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS, resetQuotaCooldownsForTesting } = await import('../../../src/shared/quota-cooldown.js');
    let starts = 0;
    const agent = { startSession: async () => { starts++; await new Promise(() => {}); } };
    const routes = new SessionRoutes(manager, db, agent as any, agent as any, agent as any,
      {} as any, worker as any, {} as any);
    (routes as any).applyTierRouting = async () => {};
    manager.queueSummarize(sid, 'Remaining summary', 2);
    session.pausedReason = 'context_retired';
    // A scheduled restart owns the session until its deadline fires.
    session.scheduledResumeTimer = setTimeout(() => {}, 60000);
    assert.deepEqual(manager.getResumableSessionIds(), []);
    clearTimeout(session.scheduledResumeTimer); session.scheduledResumeTimer = undefined;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    cleanup.push(() => { Date.now = realNow; resetQuotaCooldownsForTesting(); });
    recordQuotaExhausted('claude', 'Owned cooldown declines the immediate restart');
    await routes.ensureGeneratorRunning(sid, 'document-evidence');
    assert.equal(starts, 0);
    assert.equal(session.pausedReason, 'context_retired');
    assert.equal(routes.resumePendingSessions('periodic-resume'), 0);
    now += QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    assert.deepEqual(manager.getResumableSessionIds(), [sid], 'retired context must remain eligible after a declined restart');
    assert.equal(routes.resumePendingSessions('periodic-resume'), 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(manager.getTotalQueueDepth(), 1);
    assert.deepEqual(manager.getResumableSessionIds(), []);
    assert.equal(routes.resumePendingSessions('periodic-resume'), 0);
  } else if (kind === 'controls') {
    const controls: Array<{ name: string; messages: PendingMessage[]; xml: string; source?: string; mode?: string }> = [
      { name: 'skip', messages: [message()], xml: '<skip_summary reason="noise" />' },
      { name: 'summary', messages: [{ type: 'summarize' }], xml: summaryReply, source: 'summarize' },
      { name: 'mixed', messages: [message(), { type: 'observation', tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: '947 pass' }], xml: rawReply },
      { name: 'redacted', messages: [message('docs/redacted.md', "Credential <redacted type='openai_key'/>")], xml: rawReply },
      { name: 'observation-and-summary', messages: [message('docs/both.md')], xml: rawReply + summaryReply },
      { name: 'failed', messages: [{ ...message(), tool_response: 'Exit code: 1\nOutput:\nPatch failed' }], xml: rawReply },
      { name: 'non-code', messages: [message()], xml: rawReply, mode: 'email-investigation' },
      { name: 'init', messages: [], xml: rawReply, source: 'init' },
      { name: 'invalid', messages: [message('docs/invalid.md')], xml: 'no XML' },
    ];
    for (const control of controls) {
      // Clean state between independent parser controls, including retry counters.
      await manager.clearPendingForSession(sid);
      session.claimedMessageIds = [];
      session.retireObserverContextAfterResult = undefined;
      session.lastGeneratorSource = control.source ?? 'ingest';
      session.abortController = new AbortController(); session.abortReason = undefined;
      const mode = ModeManager.getInstance() as any;
      mode.activeModeId = control.mode ?? 'code';
      await claim(control.messages);
      const result = await run(control.xml);
      assert.equal(session.retireObserverContextAfterResult, undefined, control.name);
      if (['mixed', 'failed', 'non-code', 'redacted', 'observation-and-summary'].includes(control.name)) {
        const row = store.getObservationById(result!.observationIds[0])!;
        assert.equal(row.title, 'Production checks passed', control.name);
      }
      if (control.name === 'init') assert.equal(result, null);
      if (control.name === 'skip') assert.deepEqual(result?.observationIds, []);
      if (control.name === 'summary') assert.ok(result?.summaryId);
      if (control.name === 'invalid') assert.equal(manager.getTotalQueueDepth(), 1);
    }
  } else if (kind === 'storage-error') {
    await claim([message()]);
    store.storeObservations = () => { throw new Error('owned storage error'); };
    await assert.rejects(run(), /owned storage error/);
    assert.equal(manager.getTotalQueueDepth(), 1);
    assert.equal(session.claimedMessageIds.length, 1);
    assert.ok(!JSON.stringify(session.conversationHistory).includes('Production checks passed'));
  } else if (kind.startsWith('sdk-')) {
    // Preserve a verified prior memory and one remaining event across retirement.
    store.storeObservation('registered-memory', session.project, { type: 'discovery', title: 'Prior verified baseline', subtitle: null,
      narrative: 'Baseline executed earlier.', facts: ['Earlier baseline execution verified'], concepts: [], files_read: [], files_modified: [] }, 1);
    contextForFreshGeneration = 'Prior verified baseline: Earlier baseline execution verified';
    const m = kind === 'sdk-optimized'
      ? message('docs/large-report.md', 'Original captured document statement.\n' + 'Original source paragraph. '.repeat(1800))
      : message();
    manager.queueObservation(sid, m as any);
    manager.queueSummarize(sid, 'Summarize evidence', 2);
    if (kind === 'sdk-storage-error') store.storeObservations = () => { throw new Error('owned storage error'); };
    const provider = new ClaudeProvider(db, manager);
    let compressionCalls = 0;
    if (kind === 'sdk-optimized') (provider as any).compressField = async () => {
      compressionCalls++;
      return { text: 'Condensation says deployment and restart verified.', truncated: false };
    };
    if (kind === 'sdk-storage-error') {
      await assert.rejects(provider.startSession(session, worker), /owned storage error/);
      assert.equal(manager.getTotalQueueDepth(), 2);
      assert.equal(session.claimedMessageIds.length, 0);
      assert.equal(session.abortReason, 'transport:sdk_stream');
      assert.equal(sdkInputs.length, 1);
      assert.ok(!JSON.stringify(session.conversationHistory).includes('Production checks passed'));
      assert.equal(ordering.includes('ack'), false, 'failed storage must not acknowledge queued work');
      store.storeObservations = (...args: Parameters<typeof originalStore>) => {
        const result = originalStore(...args); ordering.push('stored'); return result;
      };
      session.abortController = new AbortController(); session.abortReason = undefined;
      await provider.startSession(session, worker);
      assert.equal(session.abortReason, 'context_retired:document_evidence');
      await Promise.all(sdkPrefetches);
      assert.equal(manager.getTotalQueueDepth(), 1);
      assert.equal(store.db.query("SELECT count(*) AS n FROM observations WHERE title != 'Prior verified baseline'").get()!.n, 1);
      assert.equal(sdkOptions[1].resume, undefined);
      assert.ok(!sdkInputs[1].text.includes('Production checks passed'));
      session.abortController = new AbortController(); session.abortReason = undefined;
      await provider.startSession(session, worker);
      await Promise.all(sdkPrefetches);
      assert.equal(manager.getTotalQueueDepth(), 0);
      assert.equal(sdkInputs.length, 3);
    } else {
      const { startGeneratorWithProvider } = await import('../../../src/services/worker/session/GeneratorRunner.js');
      const resumed: string[] = [];
      let finalized = false;
      await startGeneratorWithProvider(session, 'claude', 'ingest', null, null, {
        sessionManager: manager, sdkAgent: provider, workerService: worker,
        geminiAgent: {} as any, openRouterAgent: {} as any,
        completionHandler: { finalizeSession: async () => { finalized = true; } } as any,
        ensureGeneratorRunning: async (_id: number, source: string) => { resumed.push(source); },
        maybeSelfHealStaleClaudeSpawn: () => false,
      } as any);
      await session.generatorPromise;
      await Promise.all(sdkPrefetches);
      await new Promise(resolve => setTimeout(resolve, 10));
      if (competingReason) {
        assert.equal(session.lastResultTotalCostUsd, 0.004);
        assert.ok(telemetry.some(args => args[0] === 'session_compressed' && args[2].tokens_output === 31 && args[2].cost_usd === 0.004));
        assert.equal(finalized, kind === 'sdk-shutdown');
        assert.deepEqual(resumed, [], 'a competing abort must not schedule document retirement recovery');
        assert.equal(sdkInputs.length, 1);
        assert.ok(telemetry.some(args => args[0] === 'session_compressed' && args[2].abort_reason ===
          competingReason.split(':')[0]));
        if (kind !== 'sdk-shutdown') {
          assert.equal(manager.getSession(sid), session);
          assert.equal(session.pausedReason, competingReason.split(':')[0]);
          assert.equal(manager.getTotalQueueDepth(), 1);
        } else assert.equal(manager.getSession(sid), undefined);
      } else {
        assert.equal(finalized, false);
        assert.deepEqual(resumed, ['document-evidence']);
        assert.equal(manager.getSession(sid), session);
        assert.equal(session.pausedReason, 'context_retired');
        assert.equal(session.abortReason, null); // Runner consumed the dedicated reason.
        assert.ok(telemetry.some(args => args[0] === 'session_compressed' && args[2].abort_reason === 'context_retired'));
        assert.equal(session.consecutiveContextOverflows, 0);
        assert.equal(manager.getTotalQueueDepth(), 1);
        assert.equal(session.lastResultTotalCostUsd, 0.004);
        assert.ok(telemetry.some(args => args[0] === 'session_compressed' && args[2].tokens_output === 31 && args[2].cost_usd === 0.004));
        assert.equal(sdkInputs.length, 1);
        assert.ok(!JSON.stringify([events, synced, session.conversationHistory]).includes('Late unqualified claim'));
        const canonical = store.db.query("SELECT title, facts, narrative FROM observations WHERE title != 'Prior verified baseline'").all();
        if (kind === 'sdk-optimized') {
          assert.equal(compressionCalls, 1);
          assert.ok(sdkInputs[0].text.includes('Condensation says deployment and restart verified.'));
          assert.ok(!JSON.stringify(canonical).includes('Condensation says deployment and restart verified.'));
          assert.ok(JSON.stringify(canonical).includes('Original captured document statement.'));
          const metadata = store.db.query("SELECT metadata FROM observations WHERE title != 'Prior verified baseline'").get() as any;
          const provenance = JSON.parse(metadata.metadata).documentEvidence;
          assert.equal(provenance.inputHash, hash(m.tool_input));
          assert.ok(provenance.omittedSourceChars > 0);
          assert.ok(JSON.stringify(canonical).includes('source characters omitted'));
        }
        contextForFreshGeneration += '\n' + JSON.stringify(canonical);
        session.abortController = new AbortController(); session.abortReason = undefined;
        await provider.startSession(session, worker);
        assert.equal(manager.getTotalQueueDepth(), 0);
        assert.equal(sdkInputs.length, 2);
        assert.equal(sdkInputs[1].generation, 2);
        assert.ok(sdkInputs[1].text.includes('Prior verified baseline'));
        assert.ok(!sdkInputs[1].text.includes('Production checks passed'));
        assert.equal(sdkOptions[1].resume, undefined);
        await Promise.all(sdkPrefetches);
        assert.equal(store.db.query('SELECT count(*) AS n FROM session_summaries').get()!.n, 1);
        assert.equal(store.getSessionById(sid).memory_session_id, 'registered-memory');
      }
    }
  } else throw new Error(`Unknown fixture ${kind}`);
  console.log(JSON.stringify({ kind, status: 'passed' }));
} finally {
  session.abortController.abort();
  for (const release of cleanup.reverse()) await release();
  manager.removeSessionImmediate(sid);
  store.close();
}
