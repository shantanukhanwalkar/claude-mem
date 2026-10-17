// Owned child: SDK doubles never leak into the rest of Bun's test process.
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';

const kind = process.argv[2];
const calls: string[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: any) => (async function* () {
    const standalone = typeof prompt === 'string';
    calls.push(standalone ? (prompt.startsWith('Condense') ? 'condensation' : 'standalone') : 'observation');
    assert.equal(options.model, 'claude-sonnet-5-5');
    assert.deepEqual(options.thinking, { type: 'adaptive' });
    assert.equal(options.effort, 'medium');
    assert.equal(options.pathToClaudeCodeExecutable, '/owned/claude');
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.allowedTools, []);
    assert.equal(options.permissionMode, 'dontAsk');
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    if (!standalone) {
      const next = await prompt.next();
      assert.equal(next.done, false);
      if (kind === 'condensation') assert.match(String(next.value.message.content), /condensed payload/);
    }
    yield { type: 'system', subtype: 'init', session_id: 'owned-thinking-memory', model: 'claude-sonnet-5-5' };
    yield { type: 'assistant', session_id: 'owned-thinking-memory', message: { model: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: '', signature: 'owned-signature' },
        { type: 'text', text: standalone ? 'condensed payload' :
          '<observation><type>discovery</type><title>Owned thinking policy</title></observation>' },
      ], usage: { input_tokens: 10, output_tokens: 20 } } };
    yield { type: 'result', session_id: 'owned-thinking-memory', subtype: 'success', is_error: false, total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 20 } };
  })(),
}));
const env = { ...(await import('../../../src/shared/EnvManager.js')) };
mock.module('../../../src/shared/EnvManager.js', () => ({ ...env,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH! }),
  getAuthMethodDescription: () => 'owned-no-inference',
}));
const find = { ...(await import('../../../src/shared/find-claude-executable.js')) };
mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...find, findClaudeExecutable: () => '/owned/claude' }));
const { ClaudeProvider } = await import('../../../src/services/worker/ClaudeProvider.js');
const { SettingsDefaultsManager } = await import('../../../src/shared/SettingsDefaultsManager.js');
const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
const { SessionManager } = await import('../../../src/services/worker/SessionManager.js');
const { ModeManager } = await import('../../../src/services/domain/ModeManager.js');
SettingsDefaultsManager.loadFromFile = () => ({ ...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_MODEL: 'claude-sonnet-5-5', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false' });
ModeManager.getInstance().loadMode('code');
const store = new SessionStore(':memory:');
const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
  getChromaSync: () => null, getCloudSync: () => null } as never;
const manager = new SessionManager(db);
const sid = store.createSDKSession('thinking-content', 'thinking-project', 'Read file');
const session = manager.initializeSession(sid, 'Read file', 1);
const provider = new ClaudeProvider(db, manager);
try {
  if (kind === 'standalone') {
    const output = await provider.formatTelegramWrapup({ sessionDbId: sid,
      contentSessionId: session.contentSessionId, project: session.project, summaryText: 'Owned summary' });
    assert.equal(output, 'condensed payload');
    assert.deepEqual(calls, ['standalone']);
  } else {
    manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'owned-file.ts' },
      tool_response: kind === 'condensation' ? 'owned text '.repeat(9000) : 'Owned contents', prompt_number: 1 });
    await provider.startSession(session);
    assert.equal(manager.getTotalQueueDepth(), 0);
    assert.deepEqual(store.db.query('SELECT title, generated_by_model FROM observations').all(),
      [{ title: 'Owned thinking policy', generated_by_model: 'claude-sonnet-5-5' }]);
    assert.deepEqual(calls, kind === 'condensation' ? ['observation', 'condensation'] : ['observation']);
  }
  console.log(`Verified ${kind} policy and text after a thinking block`);
} finally {
  session.abortController.abort();
  manager.removeSessionImmediate(sid);
  store.close();
}
