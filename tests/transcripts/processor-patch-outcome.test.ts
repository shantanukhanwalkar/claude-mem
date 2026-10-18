import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { requireIngestContext, setIngestContext, type IngestContext } from '../../src/services/worker/http/shared.js';
import { fileEditHandler } from '../../src/cli/handlers/file-edit.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

// Exercise the shipped Codex call/result schema, without watching files or running tools.
const schema = JSON.parse(readFileSync(new URL('../../transcript-watch.example.json', import.meta.url), 'utf8')).schemas.codex as TranscriptSchema;
const watch: WatchTarget = { name: 'codex', path: '/unused/owned.jsonl', workspace: '/owned-project', schema };
const patch = '*** Begin Patch\n*** Update File: src/owned.ts\n@@\n-old\n+new\n*** End Patch';
let processor: TranscriptEventProcessor;
let store: SessionStore;
let queued: any[];
let fileEdits: any[];
let priorIngest: IngestContext | null;
let effects: ReturnType<typeof spyOn>[];

beforeEach(async () => {
  queued = []; fileEdits = [];
  effects = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults()),
    // file_edit is a separate real editor route; intercept its disk spool boundary here.
    spyOn(fileEditHandler, 'execute').mockImplementation(async input => { fileEdits.push(input); return { continue: true }; }),
    spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden in this offline test'); }),
  ];
  store = new SessionStore(':memory:');
  try { priorIngest = requireIngestContext(); } catch { priorIngest = null; }
  setIngestContext({ dbManager: { getSessionStore: () => store } as any,
    sessionManager: { queueObservation: (_id: number, message: any) => queued.push({ type: 'observation', ...message }) } as any,
    eventBroadcaster: { broadcastObservationQueued() {} } as any, ensureGeneratorRunning: async () => {},
  });
  processor = new TranscriptEventProcessor();
  await processor.processEntry({ type: 'session_meta', payload: { id: 'owned-transcript', cwd: '/owned-project' } }, watch, schema);
});

afterEach(() => {
  setIngestContext(priorIngest as IngestContext);
  for (const effect of effects.reverse()) effect.mockRestore();
  store.close();
});

async function call() {
  await processor.processEntry({ type: 'response_item', payload: {
    type: 'custom_tool_call', call_id: 'owned-call', name: 'apply_patch', input: patch,
  } }, watch, schema, 'owned-transcript');
}
async function result(output: string) {
  await processor.processEntry({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'owned-call', output,
  } }, watch, schema, 'owned-transcript');
}

describe('transcript patch operations require their actual outcome', () => {
  it('does not synthesize a successful write from patch input alone', async () => {
    await call();
    expect(fileEdits).toEqual([]);
    expect(queued).toEqual([]);
  });

  it('ingests the paired successful result once without an early synthetic write', async () => {
    await call();
    await result('Success. Updated the following files:\nM src/owned.ts');
    await result('Success. Updated the following files:\nM src/owned.ts');
    expect(queued).toHaveLength(1);
    expect(queued[0].tool_name).toBe('apply_patch');
    expect(JSON.parse(queued[0].tool_input)).toBe(patch);
    expect(JSON.parse(queued[0].tool_response)).toBe('Success. Updated the following files:\nM src/owned.ts');
    expect(extractObservationFileEvidence(queued)).toEqual({ files_read: [], files_modified: ['src/owned.ts'] });
    expect(fileEdits).toEqual([]);
  });

  it('retains a paired failed patch result without completed file metadata', async () => {
    await call();
    await result('Exit code: 1\nOutput:\nPatch failed');
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].tool_response)).toBe('Exit code: 1\nOutput:\nPatch failed');
    expect(extractObservationFileEvidence(queued)).toEqual({ files_read: [], files_modified: [] });
    expect(fileEdits).toEqual([]);
  });

  it('keeps explicit completed editor file_edit events on their existing route', async () => {
    const editorSchema: TranscriptSchema = { name: 'owned-editor', sessionIdPath: 'session', events: [
      { name: 'edit', match: { path: 'type', equals: 'edit' }, action: 'file_edit', fields: { filePath: 'file', edits: 'edits' } },
    ] };
    await processor.processEntry({ session: 'owned-editor', type: 'edit', file: 'src/editor.ts', edits: [{ old: 'a', new: 'b' }] },
      { ...watch, name: 'owned-editor', schema: editorSchema }, editorSchema);
    expect(fileEdits).toHaveLength(1);
    expect(fileEdits[0].filePath).toBe('src/editor.ts');
    expect(fileEdits[0].edits).toEqual([{ old: 'a', new: 'b' }]);
    expect(queued).toEqual([]);
  });
});
