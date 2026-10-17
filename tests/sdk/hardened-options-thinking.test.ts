import { describe, expect, it } from 'bun:test';
import { buildHardenedSdkOptions, OBSERVER_DISALLOWED_TOOLS } from '../../src/sdk/hardened-options.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkSpawnFactory } from '../../src/supervisor/process-registry.js';

describe('buildHardenedSdkOptions thinking policy', () => {
  const build = (source: 'Observer' | 'KnowledgeAgent', model = 'claude-haiku-4-5') =>
    buildHardenedSdkOptions({
      source,
      model,
      env: {} as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/usr/bin/claude',
    });

  it('retains disabled thinking without effort for legacy and unpinned Observer models', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'sonnet']) {
      const opts = build('Observer', model);
      expect(opts.thinking).toEqual({ type: 'disabled' });
      expect('effort' in opts).toBe(false);
    }
    // `thinkingConfig` is the SDK's internal transport field; query() ignores it
    // when passed as an option, so setting it silently leaves thinking on.
    expect('thinkingConfig' in build('Observer')).toBe(false);
  });

  it('uses supported adaptive thinking with explicit medium effort for pinned Sonnet 5.5', () => {
    const opts = build('Observer', 'claude-sonnet-5-5');
    expect(opts.thinking).toEqual({ type: 'adaptive' });
    expect(opts.effort).toBe('medium');
    expect('thinkingConfig' in opts).toBe(false);
    expect('maxThinkingTokens' in opts).toBe(false);
  });

  it('does not set thinking or effort for KnowledgeAgent sessions on either model generation', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5']) {
      const opts = build('KnowledgeAgent', model);
      expect('thinking' in opts).toBe(false);
      expect('effort' in opts).toBe(false);
      expect('thinkingConfig' in opts).toBe(false);
    }
  });

  it('defaults cwd to OBSERVER_SESSIONS_DIR, creates it, and honors an explicit cwd', () => {
    expect(build('Observer').cwd).toBe(OBSERVER_SESSIONS_DIR);
    expect(existsSync(OBSERVER_SESSIONS_DIR)).toBe(true);
    const explicit = buildHardenedSdkOptions({
      source: 'Observer',
      model: 'claude-haiku-4-5',
      env: {} as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      cwd: '/tmp/explicit-cwd',
    });
    expect(explicit.cwd).toBe('/tmp/explicit-cwd');
  });

  it('keeps lockdown fields unchanged for both sources', () => {
    for (const source of ['Observer', 'KnowledgeAgent'] as const) {
      for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5']) {
        const opts = build(source, model);
        expect(opts.tools).toEqual([]);
        expect(opts.allowedTools).toEqual([]);
        expect(opts.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
        expect(opts.permissionMode).toBe('dontAsk');
        expect(opts.mcpServers).toEqual({});
        expect(opts.settingSources).toEqual([]);
        expect(opts.strictMcpConfig).toBe(true);
        expect(opts.additionalDirectories).toEqual([]);
      }
    }
  });
});

it.skipIf(process.platform === 'win32')('passes Sonnet 5.5 thinking, effort and lockdown through SDK serialization to the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-thinking-argv-'));
  const cli = join(dir, 'claude');
  const argvPath = join(dir, 'argv.txt');
  try {
    writeFileSync(cli, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > '${argvPath}'\n`);
    chmodSync(cli, 0o755);
    try {
      for await (const _message of query({ prompt: 'owned no-inference argv probe', options: buildHardenedSdkOptions({
        source: 'Observer', model: 'claude-sonnet-5-5', env: { ...process.env },
        pathToClaudeCodeExecutable: cli, spawnClaudeCodeProcess: createSdkSpawnFactory(9_470_000 + process.pid),
      }) })) {}
    } catch {
      // The stand-in captures argv and exits without speaking the SDK protocol.
    }
    const argv = readFileSync(argvPath, 'utf8').trimEnd().split('\n');
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('adaptive');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('medium');
    expect(argv).not.toContain('disabled');
    expect(argv).toContain('--tools=');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(argv).toContain('--strict-mcp-config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

for (const kind of ['observation', 'standalone', 'condensation']) {
  it(`preserves Sonnet 5.5 policy through the ${kind} provider path`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-thinking-policy-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, '--preload', './tests/preload.ts', 'tests/fixtures/worker/claude-thinking-policy.ts', kind], {
        cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
      });
      const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned thinking-policy fixture exceeded 8 seconds')), 8000);
      })]);
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      expect(code, output).toBe(0);
      expect(output).toContain(`Verified ${kind} policy and text after a thinking block`);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
}
