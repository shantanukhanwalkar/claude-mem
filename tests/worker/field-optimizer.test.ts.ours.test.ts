import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import {
  optimizeField,
  optimizeObservationFields,
  type FieldCompressor,
} from '../../src/services/worker/field-optimizer.js';

const CTX = { sessionDbId: 1, field: 'outcome', toolName: 'Read' };
const FIELD_MAX_CHARS = 16_000;

function promptField(prompt: string, field: 'parameters' | 'outcome'): string {
  const match = prompt.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`));
  expect(match).not.toBeNull();
  return match![1];
}

describe('observation field optimization', () => {
  it('does not invoke the compressor for an oversized field', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => {
      calls++;
      return 'model-generated replacement';
    };
    const oversized = { body: 'x'.repeat(FIELD_MAX_CHARS * 3) };

    const result = await optimizeField(oversized, compress, CTX);

    expect(result).toBe(oversized);
    expect(calls).toBe(0);
  });

  it('leaves oversized fields for bounded head-tail truncation in the final prompt', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => {
      calls++;
      return 'model-generated replacement';
    };
    const toolInput = {
      body: `INPUT_HEAD_${'i'.repeat(FIELD_MAX_CHARS * 3)}_INPUT_TAIL`,
    };
    const toolOutput = {
      body: `OUTPUT_HEAD_${'o'.repeat(FIELD_MAX_CHARS * 3)}_OUTPUT_TAIL`,
    };

    const optimized = await optimizeObservationFields(
      { toolInput, toolOutput },
      compress,
      { sessionDbId: 1, toolName: 'Bash' },
    );
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: JSON.stringify(optimized.toolInput),
      tool_output: JSON.stringify(optimized.toolOutput),
      created_at_epoch: 0,
      cwd: '/repo',
    });
    const parameters = promptField(prompt, 'parameters');
    const outcome = promptField(prompt, 'outcome');

    expect(calls).toBe(0);
    expect(parameters).toContain('INPUT_HEAD');
    expect(parameters).toContain('INPUT_TAIL');
    expect(parameters).toContain('<elided');
    expect(parameters).toContain('reason="oversize"');
    expect(parameters.length).toBeLessThanOrEqual(FIELD_MAX_CHARS);
    expect(outcome).toContain('OUTPUT_HEAD');
    expect(outcome).toContain('OUTPUT_TAIL');
    expect(outcome).toContain('<elided');
    expect(outcome).toContain('reason="oversize"');
    expect(outcome.length).toBeLessThanOrEqual(FIELD_MAX_CHARS);
  });

  it('returns fitting payload fields unchanged', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => {
      calls++;
      return 'model-generated replacement';
    };
    const toolInput = { command: 'pwd' };
    const toolOutput = { output: '/repo' };

    const result = await optimizeObservationFields(
      { toolInput, toolOutput },
      compress,
      { sessionDbId: 1, toolName: 'Bash' },
    );

    expect(result.toolInput).toBe(toolInput);
    expect(result.toolOutput).toBe(toolOutput);
    expect(calls).toBe(0);
  });
});
