import { describe, expect, it } from 'bun:test';

import codeMode from '../../plugin/modes/code.json';
import {
  buildContinuationPrompt,
  buildInitPrompt,
  buildObservationPrompt,
} from '../../src/sdk/prompts.js';

const mode = codeMode as any;

describe('observer evidence boundaries', () => {
  it('marks user requests as intent rather than evidence of completed work', () => {
    const initPrompt = buildInitPrompt('project', 'session', 'merge PR 207', mode);
    const continuationPrompt = buildContinuationPrompt('close Jira', 2, 'session', mode);

    for (const prompt of [initPrompt, continuationPrompt]) {
      expect(prompt).toContain('USER REQUESTS ARE INTENT, NOT EVIDENCE');
      expect(prompt).toContain('Never claim requested work started, succeeded, changed state, or completed');
      expect(prompt).toContain('tool outcome explicitly proves it');
    }
  });

  it('requires outcome evidence and filters bookkeeping from tool observations', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'gh pr merge 207' }),
      tool_output: JSON.stringify({ output: 'merge failed' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('PARAMETERS ARE INTENT; OUTCOME IS EVIDENCE');
    expect(prompt).toContain('Never claim success from parameters alone');
    expect(prompt).toContain('Skip agent bookkeeping');
    expect(prompt).toContain('skill reads, collaboration waits/messages/follow-ups');
    expect(prompt).toContain('Skip a finding already present in the conversation history');
    expect(prompt).toContain('Pull request creation, branch pushes, Jira transitions, documentation, and configuration are change events, not features');
    expect(prompt).toContain('Return exactly <skip_observation /> when this tool use should be skipped');
    expect(prompt).not.toContain('or an empty response if this tool use should be skipped');
  });
});

describe('buildObservationPrompt', () => {
  it('instructs the observer to avoid prose skip responses', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks. Return exactly <skip_observation /> when this tool use should be skipped');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });
});

describe('buildObservationPrompt oversized field truncation (#2468)', () => {
  it('truncates an oversized outcome field with an elided marker, keeping head and tail', () => {
    const huge = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file: 'big.txt' }),
      tool_output: JSON.stringify({ content: huge }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('<elided');
    expect(prompt).toContain('reason="oversize"');
    // head and tail of the raw value are preserved
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
    // the oversized field is actually shrunk well below its raw 60k size
    expect(prompt.length).toBeLessThan(40_000);
  });

  it('leaves a small field untouched (no elided marker)', () => {
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // The prompt always carries a static "<elided chars=... />" instruction line,
    // so assert on the actual truncation marker (reason="oversize") instead.
    expect(prompt).not.toContain('reason="oversize"');
  });
});
