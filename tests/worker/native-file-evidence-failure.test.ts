import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestObservation, requireIngestContext, setIngestContext, type IngestContext } from '../../src/services/worker/http/shared.js';
import { extractObservationFileEvidence, processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import * as health from '../../src/shared/observer-health.js';
import * as telegram from '../../src/services/integrations/TelegramNotifier.js';
import * as awareness from '../../src/services/integrations/GrokBotAwarenessPusher.js';
import * as brainbeat from '../../src/services/integrations/GrokBotBrainbeat.js';
import * as indexWriter from '../../src/services/integrations/GrokBotIndexWriter.js';
import { telemetryBuffer } from '../../src/services/telemetry/buffer.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { NormalizedHookInput } from '../../src/cli/types.js';

const target = 'src/owned.ts';
const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`;
const failureReply = '<observation><type>discovery</type><title>Native operation failed</title><narrative>The tool reported a failed operation; no completed file operation is claimed.</narrative><files_read></files_read><files_modified></files_modified></observation>';
let root: string;
let store: SessionStore;
let manager: SessionManager;
let db: DatabaseManager;
let priorIngest: IngestContext | null;
let priorMode: { activeMode: unknown; activeModeId: unknown };
let effects: ReturnType<typeof spyOn>[];
let synced: any[];
let events: any[];
let order: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-file-failure-'));
  synced = []; events = []; order = [];
  effects = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    })),
    spyOn(health, 'recordObserverSuccess').mockImplementation(() => {}),
    spyOn(telegram, 'notifyTelegram').mockImplementation(async () => {}),
    spyOn(awareness, 'notifyGrokBotAwareness').mockImplementation(async () => {}),
    spyOn(brainbeat, 'notifyGrokBotBrainbeat').mockImplementation(async () => {}),
    spyOn(indexWriter, 'notifyGrokBotIndex').mockImplementation(() => {}),
    spyOn(telemetryBuffer, 'record').mockImplementation(() => {}),
    spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden in this offline test'); }),
  ];
  const mode = ModeManager.getInstance() as any;
  priorMode = { activeMode: mode.activeMode, activeModeId: mode.activeModeId };
  mode.loadMode('code');
  store = new SessionStore(join(root, 'memory.db'));
  db = {
    getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
    getChromaSync: () => ({ syncObservation: async (...args: any[]) => { synced.push(args); } }),
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
  manager = new SessionManager(db);
  try { priorIngest = requireIngestContext(); } catch { priorIngest = null; }
  setIngestContext({ dbManager: db, sessionManager: manager,
    eventBroadcaster: { broadcastObservationQueued() {} } as any, ensureGeneratorRunning: async () => {},
  });
  const originalStore = store.storeObservations.bind(store);
  effects.push(spyOn(store, 'storeObservations').mockImplementation((...args) => {
    const result = originalStore(...args); order.push('stored'); return result;
  }));
  const originalAck = manager.confirmClaimedMessages.bind(manager);
  effects.push(spyOn(manager, 'confirmClaimedMessages').mockImplementation(async id => {
    expect((store.db.query('SELECT count(*) AS n FROM observations').get() as any).n).toBe(1);
    order.push('ack'); return originalAck(id);
  }));
});

afterEach(() => {
  for (const row of store.db.query('SELECT id FROM sdk_sessions').all() as Array<{ id: number }>) {
    manager.getSession(row.id)?.abortController.abort();
    manager.removeSessionImmediate(row.id);
  }
  setIngestContext(priorIngest as IngestContext);
  Object.assign(ModeManager.getInstance(), priorMode);
  for (const effect of effects.reverse()) effect.mockRestore();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function failedNative(tool: string, input: unknown, interrupted = false): NormalizedHookInput {
  // The real PostToolUseFailure producer contract, not a failed PostToolUse.
  return claudeCodeAdapter.normalizeInput({
    session_id: 'owned-failure', cwd: root, hook_event_name: 'PostToolUseFailure',
    tool_name: tool, tool_input: input, tool_use_id: `failed-${tool}`,
    error: interrupted ? 'Operation interrupted' : 'Native precondition failed before any file operation',
    is_interrupt: interrupted,
  });
}

async function persist(inputs: NormalizedHookInput[], reply = failureReply) {
  for (const input of inputs) {
    const result = await ingestObservation({ contentSessionId: input.sessionId!, platformSource: 'claude',
      cwd: input.cwd, toolName: input.toolName!, toolInput: input.toolInput,
      toolResponse: input.toolResponse, toolUseId: input.toolUseId,
    });
    expect(result.ok).toBe(true);
  }
  const sid = (store.db.query('SELECT id FROM sdk_sessions').get() as any).id;
  const session = manager.getSession(sid)!;
  session.memorySessionId = 'owned-memory';
  session.lastGeneratorSource = 'ingest';
  session.conversationHistory = [{ role: 'user', content: 'Observed native tool results' }];
  while (manager.claimNextObservation(sid, () => true)) { /* claim this finite batch */ }
  const claimed = manager.getClaimedMessages(sid);
  expect(claimed).toHaveLength(inputs.length);
  claimed.forEach((message, i) => expect(JSON.parse(message.tool_response)).toEqual(inputs[i].toolResponse));
  const result = await processAgentResponse(reply, session, db, manager,
    { sseBroadcaster: { broadcast: event => events.push(event) } }, 10, null, 'TestAgent', undefined, 'owned-model');
  expect(result?.observationIds).toHaveLength(1);
  expect(order).toEqual(['stored', 'ack']);
  expect(manager.getTotalQueueDepth()).toBe(0);
  const row = store.db.query('SELECT * FROM observations').get() as any;
  expect(row.title).toBe('Native operation failed');
  expect(row.narrative).toBe('The tool reported a failed operation; no completed file operation is claimed.');
  expect(row.generated_by_model).toBe('owned-model');
  expect(session.conversationHistory.at(-1)?.content).toBe(reply);
  expect(synced).toHaveLength(1);
  const event = events.find(event => event.type === 'new_observation').observation;
  expect(synced[0][3].files_read).toEqual(JSON.parse(row.files_read));
  expect(synced[0][3].files_modified).toEqual(JSON.parse(row.files_modified));
  expect(event.files_read).toBe(row.files_read);
  expect(event.files_modified).toBe(row.files_modified);
  const captured = store.db.query('SELECT tool_response FROM tool_uses ORDER BY id').all() as any[];
  expect(captured.map(row => JSON.parse(row.tool_response))).toEqual(inputs.map(input => input.toolResponse));
  return { reads: JSON.parse(row.files_read), writes: JSON.parse(row.files_modified) };
}

describe('native failures must not inject completed file metadata', () => {
  for (const [tool, input] of [
    ['Read', { file_path: target }], ['Write', { file_path: target, content: 'new' }],
    ['Edit', { file_path: target, old_string: 'old', new_string: 'new' }],
  ] as const) {
    it(`retains the ${tool} failure discovery without inventing a completed file operation`, async () => {
      expect(await persist([failedNative(tool, input)])).toEqual({ reads: [], writes: [] });
    });
  }

  it('does not infer a completed write from an interrupted native call', async () => {
    expect(await persist([failedNative('Write', { file_path: target, content: 'new' }, true)]))
      .toEqual({ reads: [], writes: [] });
  });

  it('recognizes interruption even when the producer has no error text', async () => {
    const input = claudeCodeAdapter.normalizeInput({ session_id: 'owned-failure', cwd: root,
      hook_event_name: 'PostToolUseFailure', tool_name: 'Write',
      tool_input: { file_path: target, content: 'new' }, tool_use_id: 'interrupted-without-text', is_interrupt: true,
    });
    expect(await persist([input])).toEqual({ reads: [], writes: [] });
  });

  it('keeps independent successful operations at the same path in a mixed batch', async () => {
    const success = claudeCodeAdapter.normalizeInput({
      session_id: 'owned-failure', cwd: root, hook_event_name: 'PostToolUse',
      tool_name: 'Write', tool_input: { file_path: target, content: 'new' }, tool_use_id: 'successful-write',
      tool_response: { type: 'create', filePath: target, success: true },
    });
    expect(await persist([failedNative('Write', { file_path: target, content: 'new' }), success]))
      .toEqual({ reads: [], writes: [target] });
  });

  it('rejects a failed native patch receipt after the real result is ingested', async () => {
    // Paired transcript results use this same ingest boundary. Do not assume
    // the default Codex PostToolUse hook itself reports failed operations.
    const input: NormalizedHookInput = { sessionId: 'owned-failure', cwd: root,
      toolName: 'apply_patch', toolUseId: 'failed-patch',
      toolInput: { command: patch }, toolResponse: 'Exit code: 1\nOutput:\nPatch failed',
    };
    expect(await persist([input])).toEqual({ reads: [], writes: [] });
  });

  it('keeps genuine native success shapes and treats error words inside content as data', () => {
    const messages = [
      { type: 'observation' as const, tool_name: 'Read', tool_input: { file_path: 'src/read.ts' },
        tool_response: { type: 'text', file: { filePath: 'src/read.ts', content: '{"error":"example","is_interrupt":true}\nExit code: 1\nOutput:\nPatch failed', numLines: 4, startLine: 1, totalLines: 4 } } },
      { type: 'observation' as const, tool_name: 'Write', tool_input: { file_path: 'src/write.ts', content: 'new' },
        tool_response: { type: 'create', filePath: 'src/write.ts', success: true } },
      { type: 'observation' as const, tool_name: 'Edit', tool_input: { file_path: 'src/edit.ts', old_string: 'old', new_string: 'new' },
        tool_response: { filePath: 'src/edit.ts', oldString: 'old', newString: 'new', originalFile: 'old', userModified: false,
          replaceAll: false, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] } },
      { type: 'observation' as const, tool_name: 'apply_patch', tool_input: { command: patch },
        tool_response: `Success. Updated the following files:\nM ${target}` },
    ];
    expect(extractObservationFileEvidence(messages)).toEqual({
      files_read: ['src/read.ts'], files_modified: ['src/write.ts', 'src/edit.ts', target],
    });
  });

  it('only recovers a serialized transcript patch path from a matching native success receipt', () => {
    for (const outcome of [
      `Success. Updated the following files:\nM ${target}`,
      `Exit code: 0\nWall time: 0.001 seconds\nOutput:\nSuccess. Updated the following files:\nM ${target}\n`,
    ]) {
      expect(extractObservationFileEvidence([{ type: 'observation', tool_name: 'apply_patch',
        tool_input: JSON.stringify(patch), tool_response: JSON.stringify(outcome),
      }])).toEqual({ files_read: [], files_modified: [target] });
    }
    for (const outcome of [
      'Failed to find expected lines',
      'Exit code: 1\nWall time: 0.001 seconds\nOutput:\nPatch failed',
      'Success. Updated the following files:\nM src/other.ts',
      'A note quotes Success. Updated the following files:\nM src/owned.ts',
      '',
    ]) {
      expect(extractObservationFileEvidence([{ type: 'observation', tool_name: 'apply_patch',
        tool_input: JSON.stringify(patch), tool_response: JSON.stringify(outcome),
      }])).toEqual({ files_read: [], files_modified: [] });
    }
  });
});
