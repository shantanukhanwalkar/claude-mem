import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { deriveDocumentEvidence, type DocumentEvidenceMessage } from '../../src/services/worker/document-evidence.js';

const outcome = (operation: 'A' | 'M' = 'A', path = 'notes/report.md') =>
  `Exit code: 0\nOutput:\nSuccess. Updated the following files:\n${operation} ${path}`;
const add = (text = 'Verification completed.', path = 'notes/report.md'): DocumentEvidenceMessage => ({
  type: 'observation', tool_name: 'apply_patch', tool_use_id: 'call-doc', id: 42, cwd: '/workspace',
  tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n${text.split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch` },
  tool_response: outcome('A', path),
});
const update = (): DocumentEvidenceMessage => ({
  ...add(), tool_input: { patch: '*** Begin Patch\n*** Update File: notes/report.md\n@@\n retained context\n-Old claim\n+New claim\n*** End Patch' },
  tool_response: outcome('M'),
});
const write = (): DocumentEvidenceMessage => ({
  type: 'observation', tool_name: 'Write', tool_input: { file_path: '/workspace/report.txt', content: 'All checks passed.' },
  tool_response: { type: 'create', filePath: '/workspace/report.txt', success: true },
});
const edit = (): DocumentEvidenceMessage => ({
  type: 'observation', tool_name: 'Edit',
  tool_input: { file_path: 'notes/report.md', old_string: 'pending', new_string: 'passed' },
  tool_response: { filePath: 'notes/report.md', oldString: 'pending', newString: 'passed', originalFile: 'Status: pending',
    userModified: false, replaceAll: false,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-Status: pending', '+Status: passed'] }] },
});
const eligible = (message: DocumentEvidenceMessage, options?: { maxSourceChars?: number; maxFactChars?: number }) => {
  const result = deriveDocumentEvidence([message], options);
  expect(result.kind).toBe('eligible');
  if (result.kind !== 'eligible') throw new Error(result.reason);
  return result;
};
const abstains = (message: DocumentEvidenceMessage) => {
  const result = deriveDocumentEvidence([message]);
  expect(result.kind).toBe('ineligible');
  if (result.kind === 'ineligible') expect(result.reason.length).toBeGreaterThan(0);
};
const assertExactExcerpts = (result: ReturnType<typeof eligible>, sources: string[]) => {
  const quoted = result.observation.facts.filter(fact => fact.startsWith('Document source ') && fact.includes('; UTF-16 characters]: '));
  expect(quoted).toHaveLength(result.provenance.excerpts.length);
  let previousEnd = 0, retained = 0;
  result.provenance.excerpts.forEach((excerpt, index) => {
    const { sourceOffset, sourceLength } = excerpt;
    expect(sourceOffset).toBeGreaterThanOrEqual(previousEnd);
    let runOffset = 0;
    const run = sources.find(source => {
      if (sourceOffset >= runOffset && sourceOffset + sourceLength <= runOffset + source.length) return true;
      runOffset += source.length;
      return false;
    });
    expect(run).toBeDefined();
    const literal = JSON.parse(quoted[index].split('; UTF-16 characters]: ')[1]);
    expect(quoted[index]).toContain(`[offset ${sourceOffset};`);
    expect(literal).toBe(run!.slice(sourceOffset - runOffset, sourceOffset - runOffset + sourceLength));
    expect(literal).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    retained += sourceLength;
    previousEnd = sourceOffset + sourceLength;
  });
  expect(result.provenance.retainedSourceChars).toBe(retained);
  expect(result.provenance.sourceChars).toBe(sources.reduce((total, source) => total + source.length, 0));
  expect(result.provenance.omittedSourceChars).toBe(result.provenance.sourceChars - retained);
  expect(retained).toBeLessThanOrEqual(12000);
  expect(result.observation.facts.length).toBeLessThanOrEqual(32);
  expect(result.observation.facts.every(fact => fact.length <= 2000)).toBe(true);
  expect(JSON.stringify(result.observation).length).toBeLessThanOrEqual(32000);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xmlFields = Object.entries(result.observation).map(([key, value]) => {
    const element = key === 'facts' ? 'fact' : key === 'concepts' ? 'concept' : 'file';
    const body = Array.isArray(value) ? value.map(item => `<${element}>${escape(item)}</${element}>`).join('') : escape(value ?? '');
    return `  <${key}>${body}</${key}>`;
  });
  // Includes empty wrappers, so this bounds the history renderer that skips them.
  expect(`<observation>\n${xmlFields.join('\n')}\n</observation>`.length).toBeLessThanOrEqual(32000);
  expect(JSON.stringify(result.provenance).length).toBeLessThanOrEqual(4096);
};

describe('deterministic document evidence', () => {
  it('retains the opening and closing status of an oversized Write as separate exact excerpts', () => {
    const source = '# Draft proposal\n' + 'Neutral background detail.\n'.repeat(750)
      + '\nApproval: pending.\nRuntime verification: not performed.';
    const message = { ...write(), tool_input: { file_path: '/workspace/report.txt', content: source } };
    const result = eligible(message);
    expect(result.observation.facts.join('\n')).toContain('# Draft proposal');
    expect(result.observation.facts.join('\n')).toContain('Approval: pending.');
    expect(result.observation.facts.join('\n')).toContain('Runtime verification: not performed.');
    assertExactExcerpts(result, [source]);
    expect(result.provenance.retainedSourceChars).toBe(12000);
    expect(result.provenance.excerpts.every(excerpt => 10000 < excerpt.sourceOffset || 10000 >= excerpt.sourceOffset + excerpt.sourceLength)).toBe(true);
    const changedMiddle = { ...message, tool_input: { ...message.tool_input, content: source.slice(0, 10000) + '!' + source.slice(10001) } };
    expect(eligible(changedMiddle).observation.title).not.toBe(result.observation.title);
    expect(eligible(message, { maxSourceChars: 500 }).observation.title).toBe(result.observation.title);
    expect(eligible({ ...message, id: 'retry' }).observation).toEqual(result.observation);
  });

  it('retains the final disjoint patch addition when excerpt slots run out before the source budget', () => {
    const sources = ['Opening status', ...Array.from({ length: 60 }, () => 'x'), 'Final status: pending 😀'];
    const message = { ...update(), tool_input: { patch: `*** Begin Patch\n*** Update File: notes/report.md\n@@\n${sources.map(source => `+${source}\n context`).join('\n')}\n*** End Patch` } };
    const result = eligible(message);
    expect(result.observation.facts.join('\n')).toContain('Opening status');
    expect(result.observation.facts.join('\n')).toContain('Final status: pending 😀');
    assertExactExcerpts(result, sources);
    expect(result.provenance.omittedSourceChars).toBeGreaterThan(0);
  });

  it('retains both ends under XML expansion without splitting Unicode or overlapping excerpts', () => {
    const source = 'Opening 😀' + '<&'.repeat(4500) + '😀 Final status: pending';
    const result = eligible(add(source));
    expect(result.observation.facts.join('\n')).toContain('Opening 😀');
    expect(result.observation.facts.join('\n')).toContain('😀 Final status: pending');
    assertExactExcerpts(result, [source]);
    expect(result.provenance.retainedSourceChars).toBeLessThan(source.length);
  });

  it('fully preserves a short Unicode document when surrogate-safe quotes fit the fact budget', () => {
    const result = eligible(add('😀😀', 'a'.repeat(69) + '.md'), { maxFactChars: 128 });
    expect(result.provenance.retainedSourceChars).toBe(4);
    expect(result.provenance.omittedSourceChars).toBe(0);
    assertExactExcerpts(result, ['😀😀']);
    expect(result.observation.facts.every(fact => fact.length <= 128)).toBe(true);
  });

  it('handles tiny source budgets and both Unicode boundaries with exact partial counts', () => {
    for (const source of ['😀a😀b😀', 'a😀b😀z']) {
      for (let budget = 1; budget <= source.length; budget++) {
        const result = deriveDocumentEvidence([add(source)], { maxSourceChars: budget, maxFactChars: 128 });
        if (result.kind === 'ineligible') {
          expect(budget).toBe(1);
          expect(source).toBe('😀a😀b😀');
          expect(result.reason).toBe('no-source-fits-excerpt-budget');
        } else {
          assertExactExcerpts(result, [source]);
          expect(result.provenance.retainedSourceChars).toBeLessThanOrEqual(budget);
          if (budget === source.length) expect(result.provenance.omittedSourceChars).toBe(0);
        }
      }
    }
    expect(deriveDocumentEvidence([add('😀')], { maxSourceChars: 1 }).kind).toBe('ineligible');
    expect(deriveDocumentEvidence([add('text', 'a'.repeat(500) + '.md')], { maxFactChars: 128 }).kind).toBe('ineligible');
  });

  it('attributes report claims to the changed document rather than establishing the reported work (case 6)', () => {
    const result = eligible(add('Validated all 18 accounts.\nThe migration succeeded.'));
    expect(result.observation.type).toBe('change');
    expect(result.observation.title).toMatch(/^Document updated: report\.md \[[a-f0-9]{32}\]$/);
    expect(result.observation.files_modified).toEqual(['notes/report.md']);
    expect(result.observation.files_read).toEqual([]);
    expect(result.observation.concepts).toEqual(['what-changed']);
    expect(result.observation.facts[0]).toBe('Confirmed document add: "notes/report.md".');
    expect(result.observation.facts.slice(1).every(fact => fact.startsWith('Document source '))).toBe(true);
    expect(result.observation.facts.join('\n')).toContain('"Validated all 18 accounts.\\nThe migration succeeded."');
    expect(result.observation.narrative).toContain('do not independently establish the actions described');
    expect(result.observation.narrative).not.toContain('never');
    expect(result.provenance).toMatchObject({ version: 'document-evidence-v1', toolName: 'apply_patch', toolUseId: 'call-doc', messageId: 42, operation: 'add', path: 'notes/report.md' });
    expect(result.provenance.inputHash).toBe(createHash('sha256').update(JSON.stringify(add('Validated all 18 accounts.\nThe migration succeeded.').tool_input)).digest('hex'));
  });

  it('quotes only additions from an update and does not resurrect removed or context claims (case 10)', () => {
    const result = eligible(update());
    expect(result.provenance.operation).toBe('update');
    expect(result.observation.facts.join('\n')).toContain('"New claim"');
    expect(result.observation.facts.join('\n')).not.toContain('Old claim');
    expect(result.observation.facts.join('\n')).not.toContain('retained context');
  });

  it('accepts the historical captured success envelope with exit code, wall time and matching absolute path', () => {
    const message = add('Audit complete.', '/home/sk/example/report.md');
    message.tool_response = JSON.stringify('Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA /home/sk/example/report.md\n');
    expect(eligible(message).observation.files_modified).toEqual(['/home/sk/example/report.md']);
    abstains({ ...message, tool_response: 'Exit code: 0\nWall time: unknown seconds\nOutput:\nSuccess. Updated the following files:\nA /home/sk/example/report.md\n' });
  });

  it('abstains when structured source contains XML-invalid controls or malformed newline markers', () => {
    abstains(add('hidden\u0000value'));
    const response = edit().tool_response as any;
    abstains({ ...edit(), tool_response: { ...response, structuredPatch: [{ ...response.structuredPatch[0], lines: ['\\ No newline at end of file', '-Status: pending', '+Status: passed'] }] } });
  });

  it('requires complete native success rather than trusting the patch input (case 7)', () => {
    for (const response of [undefined, '', 'Success. Updated the following files:\nA notes/report.md',
      outcome().replace('code: 0', 'code: 1'), outcome().replace('notes/report.md', 'other.md'),
      outcome() + '\nError: later failure', outcome() + '\nM other.md', outcome('M'),
      'Exit code: 0\nOutput:\n' + outcome(), { success: true }, '<condensed>success</condensed>']) {
      abstains({ ...add(), tool_response: response });
    }
  });

  it('rejects malformed, truncated, redacted, moved, deleted, multiple-file and executable document patches', () => {
    const patch = (add().tool_input as any).command;
    for (const command of [patch.replace('*** End Patch', ''), patch + '\ntrailing',
      patch.replace('+Verification', 'Verification'), patch.replace('*** Add File:', '*** Delete File:'),
      patch.replace('+Verification', '*** Move to: other.md\n+Verification'),
      patch.replace('*** End Patch', '*** Add File: code.ts\n+x\n*** End Patch'),
      patch.replace('Verification completed.', '<redacted type=\'custom\'/>'),
      patch.replace('Verification completed.', '[truncated]'), patch.replace('Verification completed.', '<private>hidden</private>')]) {
      abstains({ ...add(), tool_input: { command } });
    }
    for (const path of ['page.mdx', 'page.rmd', 'page.qmd', 'script.ts', '../escape.md', 'report.md\nA other.md']) abstains(add('text', path));
    abstains({ ...update(), tool_input: { patch: '*** Begin Patch\n*** Update File: notes/report.md\n+new\n*** End Patch' } });
    abstains({ ...add(), tool_input: { command: patch, patch: patch.replace('Verification', 'Other') } });
  });

  it('accepts only one claimed observation and abstains for mixed, empty, summary and unknown operations', () => {
    for (const messages of [[], [add(), add()], [add(), { type: 'observation', tool_name: 'Read' }],
      [{ ...add(), type: 'summarize' }], [{ ...add(), tool_name: 'Bash' }]]) {
      expect(deriveDocumentEvidence(messages).kind).toBe('ineligible');
    }
  });

  it('decodes up to three JSON string layers and keeps original capture hashes', () => {
    const wrapped = { ...add(), tool_input: JSON.stringify(JSON.stringify(JSON.stringify(add().tool_input))),
      tool_response: JSON.stringify(JSON.stringify(outcome())) };
    const result = eligible(wrapped);
    expect(result.observation).toEqual(eligible(add()).observation);
    expect(result.provenance.inputHash).toBe(createHash('sha256').update(wrapped.tool_input).digest('hex'));
    abstains({ ...wrapped, tool_input: JSON.stringify(wrapped.tool_input) });
  });

  it('normalizes path syntax without permitting path disagreement', () => {
    expect(eligible(add('text', './notes/report.md')).observation.files_modified).toEqual(['notes/report.md']);
    abstains({ ...add(), tool_response: outcome('A', '/workspace/notes/report.md') });
    abstains({ ...add(), tool_response: outcome('A', 'notes/../report.md') });
  });

  it('accepts the explicit native Write create outcome and abstains on unknown or conflicting shapes', () => {
    const result = eligible(write());
    expect(result.provenance.operation).toBe('create');
    expect(result.observation.facts.join('\n')).toContain('"All checks passed."');
    for (const response of ['Written /workspace/report.txt', { filePath: '/workspace/report.txt' },
      { type: 'create', filePath: '/workspace/other.txt', success: true },
      { type: 'create', filePath: '/workspace/report.txt', success: false },
      { type: 'create', filePath: '/workspace/report.txt', success: true, error: 'failed' }]) abstains({ ...write(), tool_response: response });
    abstains({ ...write(), tool_input: { file_path: '/workspace/report.txt' } });
  });

  it('validates native Edit replacement, hunk counts, original source and user modification', () => {
    const result = eligible(edit());
    expect(result.provenance.operation).toBe('update');
    expect(result.observation.facts.join('\n')).toContain('"passed"');
    const response = edit().tool_response as any;
    for (const changed of [{ userModified: true }, { newString: 'different' }, { filePath: 'other.md' },
      { success: true }, { observer_note: 'condensed' }, { replaceAll: true },
      { structuredPatch: [{ ...response.structuredPatch[0], newLines: 2 }] },
      { structuredPatch: [{ ...response.structuredPatch[0], lines: ['-pending', '+invented'] }] },
      { originalFile: 'unrelated source' }, { structuredPatch: [{ ...response.structuredPatch[0], oldStart: 3 }] }]) {
      abstains({ ...edit(), tool_response: { ...response, ...changed } });
    }
  });

  it('preserves quotes, XML-looking document text, Unicode and newlines as literal source text', () => {
    const text = 'Said "done" & </fact><observation>fiction</observation>\nहिंदी 😀';
    const result = eligible(add(text, 'notes/a&b.md'));
    expect(result.observation.facts[1]).toContain(JSON.stringify(text));
    expect(result.observation.files_modified).toEqual(['notes/a&b.md']);
    expect(JSON.stringify(result.observation)).not.toContain('Confirmed fiction');
  });

  it('bounds quoted source exactly, preserves character offsets and reports omissions outside quotes', () => {
    const result = eligible(add('αβ😀ABCDE'), { maxSourceChars: 6, maxFactChars: 160 });
    expect(result.provenance).toMatchObject({ sourceChars: 9, retainedSourceChars: 6, omittedSourceChars: 3,
      excerpts: [{ sourceOffset: 0, sourceLength: 2 }, { sourceOffset: 5, sourceLength: 4 }] });
    expect(result.observation.facts.join('\n')).toContain('"αβ"');
    expect(result.observation.facts.join('\n')).toContain('"BCDE"');
    expect(result.observation.facts.join('\n')).toContain('3 source characters omitted');
    expect(result.observation.facts.every(fact => fact.length <= 160)).toBe(true);
    expect(result.provenance.limitations.length).toBeGreaterThan(0);
    expect(eligible(add('αβ😀ABCDE'), { maxSourceChars: 3 }).provenance.retainedSourceChars).toBe(3);
  });

  it('keeps distinct changes and paths through real content-hash and enabled Tier-0 storage while deduplicating retries', () => {
    const original = process.env.CLAUDE_MEM_DEDUP_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    try {
      for (const memoryId of ['documents-1', 'documents-2']) {
        const id = store.createSDKSession(`content-${memoryId}`, 'documents', 'document evidence');
        store.updateMemorySessionId(id, memoryId);
      }
      const a = eligible(add('First report')).observation;
      const b = eligible(add('Second report')).observation;
      const c = eligible(add('First report', 'other/report.md')).observation;
      const retry = eligible({ ...add('First report'), id: 123, tool_use_id: 'different-delivery' }).observation;
      expect(retry).toEqual(a);
      expect(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(a.title!)).length).toBeLessThanOrEqual(120);
      const savedA = store.storeObservation('documents-1', 'documents', a);
      const savedB = store.storeObservation('documents-1', 'documents', b);
      const savedC = store.storeObservation('documents-2', 'documents', c);
      expect(new Set([savedA.id, savedB.id, savedC.id]).size).toBe(3);
      expect(store.storeObservation('documents-1', 'documents', retry).id).toBe(savedA.id);
      const crossSessionRetry = store.storeObservation('documents-2', 'documents', retry);
      expect(crossSessionRetry.id).toBe(savedA.id);
      expect(crossSessionRetry.mergedIntoExisting).toBe(true);
      const stored = store.db.query('SELECT id, facts FROM observations ORDER BY id').all() as Array<{ id: number; facts: string }>;
      expect(stored).toHaveLength(3);
      expect(stored.map(row => JSON.parse(row.facts).join('\n'))).toEqual([a.facts.join('\n'), b.facts.join('\n'), c.facts.join('\n')]);
    } finally {
      store.close();
      if (original === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
      else process.env.CLAUDE_MEM_DEDUP_ENABLED = original;
    }
  });

  it('bounds thousands of disjoint additions without inventing contiguous source or losing omission counts', () => {
    const message = { ...update(), tool_input: { patch: `*** Begin Patch\n*** Update File: notes/report.md\n@@\n${Array.from({ length: 12000 }, () => '+x\n context').join('\n')}\n*** End Patch` } };
    const result = eligible(message);
    expect(result.observation.facts.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(result.observation).length).toBeLessThanOrEqual(32000);
    expect(JSON.stringify(result.provenance).length).toBeLessThanOrEqual(4096);
    expect(result.provenance.sourceChars).toBe(12000);
    expect(result.provenance.omittedSourceChars).toBe(12000 - result.provenance.retainedSourceChars);
    expect(result.provenance.omittedSourceChars).toBeGreaterThan(0);
    expect(result.provenance.excerpts).toHaveLength(30);
    expect(result.provenance.excerpts[0]).toEqual({ sourceOffset: 0, sourceLength: 1 });
    expect(result.provenance.excerpts.at(-1)).toEqual({ sourceOffset: 11999, sourceLength: 1 });
    assertExactExcerpts(result, Array.from({ length: 12000 }, () => 'x'));
    expect(result.observation.facts.slice(1, -1).every(fact => fact.endsWith(': "x"'))).toBe(true);
  });

  it('bounds escaped XML rendering and preserves Unicode boundaries under the total budget', () => {
    const result = eligible(add('<&😀'.repeat(4000)));
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Lower bound on the actual existing XML renderer: tags only increase its size.
    expect(result.observation.facts.map(escape).join('').length).toBeLessThan(32000);
    expect(result.provenance.retainedSourceChars).toBeLessThan(12000);
    expect(result.provenance.retainedSourceChars + result.provenance.omittedSourceChars).toBe(16000);
    const source = '<&😀'.repeat(4000);
    for (const excerpt of result.provenance.excerpts) {
      const slice = source.slice(excerpt.sourceOffset, excerpt.sourceOffset + excerpt.sourceLength);
      expect(slice).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('bounds provenance identities and rejects non-string tool IDs instead of weakening the exported contract', () => {
    abstains({ ...add(), tool_use_id: 'x'.repeat(257) });
    abstains({ ...add(), id: 'x'.repeat(257) });
    abstains({ ...add(), tool_use_id: 42 } as unknown as DocumentEvidenceMessage);
  });

  it('identifies the deterministic transformation and records omissions without promising a raw capture link', () => {
    const result = eligible({ ...add('longer source'), tool_use_id: undefined, id: undefined }, { maxSourceChars: 3 });
    expect(result.observation.narrative).toContain('Deterministic document-evidence-v1 transformation');
    expect(JSON.stringify(result)).not.toContain('linked raw');
    expect(JSON.stringify(result)).not.toContain('full source remains');
    expect(result.observation.facts.join('\n')).toContain('10 source characters omitted');
    expect(result.provenance.toolUseId).toBeNull();
  });

  it('keeps large escaped excerpts within actual fact and total source budgets with deterministic output', () => {
    const message = add('"\\\n😀'.repeat(4000));
    const first = eligible(message);
    expect(first.provenance.retainedSourceChars).toBeLessThanOrEqual(12000);
    expect(first.provenance.omittedSourceChars).toBeGreaterThan(0);
    expect(first.observation.facts.every(fact => fact.length <= 2000)).toBe(true);
    expect(first).toEqual(eligible(message));
    expect(first.observation.title).toBe(eligible(message).observation.title);
    expect(() => deriveDocumentEvidence([{ ...add(), tool_input: 1n }])).not.toThrow();
  });
});
