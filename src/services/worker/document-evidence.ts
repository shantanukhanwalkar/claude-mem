import { createHash } from 'node:crypto';
import type { ParsedObservation } from '../../sdk/parser.js';

/** Original, already capture-sanitized queue message; never an optimized prompt view. */
export interface DocumentEvidenceMessage {
  type?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string | null;
  toolUseId?: string | null;
  cwd?: string | null;
  id?: number | string;
  _persistentId?: number;
}
export interface DocumentEvidenceOptions {
  maxSourceChars?: number;
  maxFactChars?: number;
}
export interface DocumentEvidenceProvenance {
  version: 'document-evidence-v1';
  toolName: string;
  toolUseId: string | null;
  messageId: number | string | null;
  operation: 'add' | 'update' | 'create';
  path: string;
  inputHash: string;
  outputHash: string;
  sourceChars: number;
  retainedSourceChars: number;
  omittedSourceChars: number;
  excerpts: Array<{ sourceOffset: number; sourceLength: number }>;
  limitations: string[];
}
export type DocumentEvidenceResult =
  | { kind: 'eligible'; observation: ParsedObservation; provenance: DocumentEvidenceProvenance }
  | { kind: 'ineligible'; reason: string };

const MAX_CAPTURE_CHARS = 1_048_576;
const MAX_SOURCE_CHARS = 12_000;
const MAX_FACT_CHARS = 2_000;
const MAX_FACTS = 32;
const MAX_OBSERVATION_CHARS = 32_000;
const MAX_PROVENANCE_CHARS = 4_096;
const BAD_CAPTURE = /(?:<|&lt;)(?:redacted|private|elided|condensed|truncated)\b|\[(?:REDACTED|truncated|elided|omitted)(?:[\s:][^\]]*)?\]|\b(?:output truncated|characters? omitted|source characters omitted)\b/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
type RecordValue = Record<string, unknown>;
type NativeEvidence = { path: string; operation: DocumentEvidenceProvenance['operation']; sources: string[]; identitySource: unknown };

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keysOnly(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function capturedText(value: unknown): string | null {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof serialized === 'string' && serialized.length <= MAX_CAPTURE_CHARS
    && !BAD_CAPTURE.test(serialized) && !CONTROL.test(serialized) ? serialized : null;
}
function safeCapturedStrings(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === 'string') return !BAD_CAPTURE.test(value) && !CONTROL.test(value);
  if (Array.isArray(value)) return value.every(item => safeCapturedStrings(item, depth + 1));
  if (record(value)) return Object.entries(value).every(([key, child]) => safeCapturedStrings(key, depth + 1) && safeCapturedStrings(child, depth + 1));
  return true;
}
function decode(value: unknown): unknown {
  for (let layer = 0; layer < 3 && typeof value === 'string'; layer++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}
/** Relative paths remain relative: cwd is not evidence for a different outcome path. */
function documentPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value
    || /[\u0000-\u001f\u007f\\]/.test(value) || BAD_CAPTURE.test(value)) return null;
  const parts = value.split('/');
  if (parts.includes('..')) return null;
  const normalized = (value.startsWith('/') ? '/' : '') + parts.filter(part => part && part !== '.').join('/');
  return /\.(?:md|markdown|txt|rst)$/i.test(normalized) ? normalized : null;
}
function patchInput(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!record(value) || !keysOnly(value, ['command', 'patch'])) return null;
  if (typeof value.command === 'string' && value.patch === undefined) return value.command;
  if (typeof value.patch === 'string' && value.command === undefined) return value.patch;
  return null;
}

function nativePatch(input: unknown, output: unknown): NativeEvidence | null {
  const patch = patchInput(input);
  if (patch === null || typeof output !== 'string' || patch.includes('\r') || output.includes('\r')) return null;
  const lines = patch.replace(/\n$/, '').split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return null;
  const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(lines.shift() ?? '');
  if (!header) return null;
  const path = documentPath(header[2]);
  if (!path) return null;
  const operation = header[1] === 'Add' ? 'add' : 'update';
  const expected = `Success. Updated the following files:\n${operation === 'add' ? 'A' : 'M'} `;
  // Full native command envelope, not a success substring or a model-authored summary.
  const result = /^Exit code: 0\n(?:Wall time: (?:0|[1-9]\d{0,8})(?:\.\d{1,9})? seconds\n)?Output:\n([\s\S]*?)\n?$/.exec(output);
  if (!result || !result[1].startsWith(expected)) return null;
  const outcomePath = result[1].slice(expected.length);
  if (documentPath(outcomePath) !== path || outcomePath.includes('\n')) return null;
  const sources: string[] = [];
  let added: string[] = [];
  const flush = () => { if (added.length) sources.push(added.join('\n')); added = []; };
  if (operation === 'add') {
    if (!lines.length || lines.some(line => !line.startsWith('+'))) return null;
    sources.push(lines.map(line => line.slice(1)).join('\n'));
  } else {
    let inHunk = false, changed = false, endOfFile = false;
    for (const line of lines) {
      if (/^@@(?: .+)?$/.test(line)) {
        if (endOfFile || (inHunk && !changed)) return null;
        flush(); inHunk = true; changed = false;
      } else if (line === '*** End of File') {
        if (!inHunk || !changed || endOfFile) return null;
        flush(); endOfFile = true;
      } else {
        if (!inHunk || endOfFile || !/^[ +\-]/.test(line)) return null;
        if (line[0] === '+') { added.push(line.slice(1)); changed = true; }
        else { flush(); if (line[0] === '-') changed = true; }
      }
    }
    if (!inHunk || !changed) return null;
    flush();
  }
  return sources.some(source => source.length > 0) ? { path, operation, sources, identitySource: [path, operation, lines] } : null;
}

function nativeWrite(input: unknown, output: unknown): NativeEvidence | null {
  if (!record(input) || !record(output)
    || !keysOnly(input, ['file_path', 'content']) || !keysOnly(output, ['type', 'filePath', 'success'])
    || typeof input.content !== 'string' || !input.content.length
    || output.type !== 'create' || output.success !== true) return null;
  const path = documentPath(input.file_path);
  return path && documentPath(output.filePath) === path ? { path, operation: 'create', sources: [input.content], identitySource: [path, 'create', input.content] } : null;
}

/** Validates original native data; condensed structuredPatch views are never proof. */
function nativeEdit(input: unknown, output: unknown): NativeEvidence | null {
  if (!record(input) || !record(output)
    || !keysOnly(input, ['file_path', 'old_string', 'new_string', 'replace_all'])
    || !keysOnly(output, ['filePath', 'oldString', 'newString', 'originalFile', 'structuredPatch', 'userModified', 'replaceAll'])
    || typeof input.old_string !== 'string' || !input.old_string.length
    || typeof input.new_string !== 'string' || !input.new_string.length || input.old_string === input.new_string
    || output.oldString !== input.old_string || output.newString !== input.new_string || output.userModified !== false
    || (output.originalFile !== null && typeof output.originalFile !== 'string')
    || (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')
    || (output.replaceAll !== undefined && output.replaceAll !== (input.replace_all ?? false))
    || !Array.isArray(output.structuredPatch) || !output.structuredPatch.length) return null;
  const path = documentPath(input.file_path);
  if (!path || documentPath(output.filePath) !== path) return null;
  let priorOldEnd = 0, priorNewEnd = 0, delta = 0, replacements = 0;
  const originalLines = typeof output.originalFile === 'string' ? output.originalFile.split('\n') : null;
  for (const hunk of output.structuredPatch) {
    if (!record(hunk) || !keysOnly(hunk, ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines'])
      || !['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isSafeInteger(hunk[key]) && Number(hunk[key]) >= 0)
      || Number(hunk.oldStart) < 1 || Number(hunk.newStart) < 1
      || !Array.isArray(hunk.lines) || !hunk.lines.length
      || !hunk.lines.every(line => typeof line === 'string' && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file'))) return null;
    const lines = hunk.lines as string[];
    if (lines.some((line, index) => line === '\\ No newline at end of file'
      && (index === 0 || lines[index - 1] === '\\ No newline at end of file'))) return null;
    const oldStart = Number(hunk.oldStart), newStart = Number(hunk.newStart);
    const oldLines = Number(hunk.oldLines), newLines = Number(hunk.newLines);
    if (oldStart < priorOldEnd || newStart < priorNewEnd || newStart !== oldStart + delta
      || hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').length !== oldLines
      || hunk.lines.filter(line => line[0] === ' ' || line[0] === '+').length !== newLines) return null;
    const before = hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').map(line => line.slice(1)).join('\n');
    const after = hunk.lines.filter(line => line[0] === ' ' || line[0] === '+').map(line => line.slice(1)).join('\n');
    const count = before.split(input.old_string).length - 1;
    const replaced = input.replace_all ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, () => input.new_string as string);
    if (!count || replaced !== after || (originalLines && originalLines.slice(oldStart - 1, oldStart - 1 + oldLines).join('\n') !== before)) return null;
    replacements += input.replace_all ? count : 1;
    delta += newLines - oldLines;
    priorOldEnd = oldStart + oldLines; priorNewEnd = newStart + newLines;
  }
  if (!input.replace_all && replacements !== 1) return null;
  if (typeof output.originalFile === 'string'
    && (output.originalFile.split(input.old_string).length - 1 !== replacements)) return null;
  return { path, operation: 'update', sources: [input.new_string], identitySource: [path, 'update',
    input.old_string, input.new_string, input.replace_all ?? false,
    output.structuredPatch.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines, hunk.lines])] };
}

function boundedOption(value: number | undefined, fallback: number, minimum: number): number | null {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= minimum && value <= fallback ? value : null;
}
function safeEnd(text: string, end: number): number {
  // UTF-16 offsets match captured string lengths, without splitting a surrogate pair.
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}

function escapedXmlSize(value: string): number {
  return value.length + (value.match(/&/g)?.length ?? 0) * 4
    + (value.match(/[<>]/g)?.length ?? 0) * 3;
}
/** Upper bound for the existing renderer: includes every field, even empty lists it skips. */
function renderedObservationSize(observation: ParsedObservation): number {
  let size = '<observation>\n</observation>'.length;
  for (const [key, value] of Object.entries(observation)) {
    const element = key === 'facts' ? 'fact' : key === 'concepts' ? 'concept' : 'file';
    const textSize = Array.isArray(value)
      ? value.reduce((total: number, item: string) => total + escapedXmlSize(item) + element.length * 2 + 5, 0)
      : escapedXmlSize(value ?? '');
    size += 2 + key.length * 2 + 5 + textSize + 1;
  }
  return size;
}
function omissionFact(omitted: number): string {
  return `Document source excerpt limit: ${omitted} source characters omitted.`;
}

/**
 * Establishes one successful document artifact change, never the truth of its prose.
 * Call only with original payloads after the existing capture privacy/redaction boundary.
 * No settings, filesystem, process, network, model output or current-clock inputs are read.
 */
export function deriveDocumentEvidence(
  messages: readonly DocumentEvidenceMessage[], options: DocumentEvidenceOptions = {},
): DocumentEvidenceResult {
  const abstain = (reason: string): DocumentEvidenceResult => ({ kind: 'ineligible', reason });
  if (messages.length !== 1 || messages[0]?.type !== 'observation') return abstain('requires-one-observation');
  const maxSourceChars = boundedOption(options.maxSourceChars, MAX_SOURCE_CHARS, 1);
  const maxFactChars = boundedOption(options.maxFactChars, MAX_FACT_CHARS, 128);
  if (maxSourceChars === null || maxFactChars === null) return abstain('invalid-excerpt-limits');
  const message = messages[0];
  try {
    const inputText = capturedText(message.tool_input), outputText = capturedText(message.tool_response);
    if (inputText === null || outputText === null) return abstain('missing-incomplete-or-redacted-capture');
    const input = decode(message.tool_input), output = decode(message.tool_response);
    if (capturedText(input) === null || capturedText(output) === null || !safeCapturedStrings(input) || !safeCapturedStrings(output)) return abstain('incomplete-or-redacted-decoded-capture');
    const evidence = message.tool_name === 'apply_patch' ? nativePatch(input, output)
      : message.tool_name === 'Write' ? nativeWrite(input, output)
      : message.tool_name === 'Edit' ? nativeEdit(input, output) : null;
    if (!evidence) return abstain('unsupported-or-inconsistent-native-outcome');
    const toolUseId = message.tool_use_id ?? message.toolUseId ?? null;
    const messageId = message.id ?? message._persistentId ?? null;
    if ((toolUseId !== null && typeof toolUseId !== 'string') || [toolUseId, messageId].some(value => value !== null && (
      typeof value === 'string' ? value.length > 256 || !safeCapturedStrings(value)
        : typeof value !== 'number' || !Number.isSafeInteger(value)))) return abstain('invalid-capture-identity');
    // Both storage content-hash and Tier-0 normalized-title dedup must retain distinct changes.
    // Hash the complete validated change, including text outside the excerpt budget; delivery IDs
    // and outcome timing are deliberately excluded so an identical retry has the same identity.
    const identity = createHash('sha256').update(JSON.stringify([
      'document-evidence-v1', message.tool_name, evidence.identitySource,
    ])).digest('hex').slice(0, 32);
    const facts = [`Confirmed document ${evidence.operation}: ${JSON.stringify(evidence.path)}.`];
    if (facts[0].length > maxFactChars) return abstain('path-exceeds-fact-budget');
    const excerpts: DocumentEvidenceProvenance['excerpts'] = [];
    const sourceChars = evidence.sources.reduce((total, source) => total + source.length, 0);
    const basename = evidence.path.split('/').pop()!;
    const titleName = basename.slice(0, safeEnd(basename, Math.min(60, basename.length)));
    const makeObservation = (observationFacts: string[], omitted: number): ParsedObservation => ({
      type: 'change', title: `Document updated: ${titleName} [${identity}]`,
      subtitle: `Confirmed document ${evidence.operation}; quoted prose is attributed to the document.`,
      facts: observationFacts,
      narrative: `Deterministic document-evidence-v1 transformation (evidence ${identity}): native ${message.tool_name} evidence confirms a document ${evidence.operation} at ${JSON.stringify(evidence.path)}. The document-source excerpts above do not independently establish the actions described in that prose.${omitted ? ` ${omitted} source characters omitted from this observation.` : ''}`,
      concepts: ['what-changed'], files_read: [], files_modified: [evidence.path],
    });
    // Reserve the longest omission notice before quoting anything. Charge each fact against
    // BOTH JSON and escaped XML size; neither encoding nor many short disjoint runs may expand
    // the stored/replayed observation beyond its total budget. Keep two slots for notices.
    const reserved = makeObservation([...facts, omissionFact(sourceChars)], sourceChars);
    let remainingOutputChars = MAX_OBSERVATION_CHARS
      - Math.max(renderedObservationSize(reserved), JSON.stringify(reserved).length);
    let sourceOffset = 0, retainedSourceChars = 0;
    const runs = evidence.sources.map(source => {
      const run = { source, offset: sourceOffset, start: 0, end: source.length };
      sourceOffset += source.length;
      return run;
    });
    const selected: Array<{ fact: string; sourceOffset: number; sourceLength: number }> = [];
    let head = 0, tail = runs.length - 1, fromHead = true, attemptsWithoutProgress = 0;
    let firstAttempt = true;
    // Visit both ends before filling the middle. Source, fact-count and encoded-output
    // limits can each truncate a capture, including captures below the source limit.
    // Cursors share each run's unconsumed interval, so excerpts never overlap or
    // join separate patch additions into an invented contiguous quotation.
    while (selected.length < MAX_FACTS - 2 && retainedSourceChars < maxSourceChars) {
      while (head <= tail && runs[head].start === runs[head].end) head++;
      while (head <= tail && runs[tail].start === runs[tail].end) tail--;
      if (head > tail) break;
      const run = runs[fromHead ? head : tail];
      // Round inward before measuring, too: JSON escapes a lone surrogate, so
      // measuring split pairs would make the binary-search cost non-monotonic.
      const safeLength = (length: number) => fromHead ? safeEnd(run.source, run.start + length) - run.start
        : length - (safeEnd(run.source, run.end - length) < run.end - length ? 1 : 0);
      const offsetFor = (length: number) => run.offset + (fromHead ? run.start : run.end - length);
      const factFor = (candidateLength: number) => {
        const length = safeLength(candidateLength);
        return `Document source ${JSON.stringify(evidence.path)} [offset ${offsetFor(length)}; UTF-16 characters]: `
          + JSON.stringify(fromHead ? run.source.slice(run.start, run.start + length) : run.source.slice(run.end - length, run.end));
      };
      const factCost = (fact: string) => Math.max(escapedXmlSize(fact) + '<fact></fact>'.length, JSON.stringify(fact).length + 1);
      const sourceBudget = firstAttempt && sourceChars > maxSourceChars ? Math.ceil(maxSourceChars / 2) : maxSourceChars - retainedSourceChars;
      const outputBudget = firstAttempt ? Math.floor(remainingOutputChars / 2) : remainingOutputChars;
      firstAttempt = false;
      let low = 0, high = Math.min(run.end - run.start, sourceBudget);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = factFor(middle);
        if (candidate.length <= maxFactChars && factCost(candidate) <= outputBudget) low = middle;
        else high = middle - 1;
      }
      const length = safeLength(low);
      if (length > 0) {
        const fact = factFor(length);
        selected.push({ fact, sourceOffset: offsetFor(length), sourceLength: length });
        remainingOutputChars -= factCost(fact);
        retainedSourceChars += length;
        if (fromHead) run.start += length;
        else run.end -= length;
        attemptsWithoutProgress = 0;
      } else if (++attemptsWithoutProgress >= 2) break;
      fromHead = !fromHead;
    }
    // Deliver source order while keeping every quotation paired with its provenance.
    selected.sort((a, b) => a.sourceOffset - b.sourceOffset);
    for (const { fact, sourceOffset, sourceLength } of selected) {
      facts.push(fact);
      excerpts.push({ sourceOffset, sourceLength });
    }
    if (!retainedSourceChars) return abstain('no-source-fits-excerpt-budget');
    const omittedSourceChars = sourceChars - retainedSourceChars;
    if (omittedSourceChars) facts.push(omissionFact(omittedSourceChars));
    const observation = makeObservation(facts, omittedSourceChars);
    if (facts.some(fact => fact.length > maxFactChars)
      || renderedObservationSize(observation) > MAX_OBSERVATION_CHARS
      || JSON.stringify(observation).length > MAX_OBSERVATION_CHARS) return abstain('observation-exceeds-output-budget');
    const provenance: DocumentEvidenceProvenance = {
      version: 'document-evidence-v1', toolName: message.tool_name!, toolUseId, messageId,
      operation: evidence.operation, path: evidence.path,
      inputHash: createHash('sha256').update(inputText).digest('hex'),
      outputHash: createHash('sha256').update(outputText).digest('hex'),
      sourceChars, retainedSourceChars, omittedSourceChars, excerpts,
      limitations: [
        'Document prose is source-attributed and does not independently establish the reported actions.',
        'Offsets are UTF-16 character positions in ordered added-source runs (patch), new_string (Edit), or content (Write); unchanged and removed text are excluded.',
        ...(omittedSourceChars ? ['Source text was omitted to bound this observation; availability of the full capture is not established here.'] : []),
      ],
    };
    if (JSON.stringify(provenance).length > MAX_PROVENANCE_CHARS) return abstain('provenance-exceeds-output-budget');
    return { kind: 'eligible', observation, provenance };
  } catch {
    return abstain('malformed-or-unserializable-capture');
  }
}
