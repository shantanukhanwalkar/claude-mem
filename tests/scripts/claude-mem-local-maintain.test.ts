import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, '../../scripts/claude-mem-local-maintain.sh');
const tempRoots: string[] = [];

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = run(['git', ...args], cwd, {
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function commitFile(repo: string, path: string, content: string, message: string): string {
  writeFileSync(join(repo, path), content);
  git(repo, 'add', path);
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function createFixture(options: { conflict?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-maintain-'));
  tempRoots.push(root);
  const upstream = join(root, 'upstream.git');
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const forkRoot = join(root, 'fork');
  const upstreamWork = join(root, 'upstream-work');
  const stateDir = join(root, 'state');
  const hooksDir = join(root, 'hooks');
  const commandLog = join(root, 'commands.log');

  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(join(seed, 'base.txt'), 'base\n');
  writeFileSync(join(seed, 'conflict.txt'), 'shared base\n');
  git(seed, 'add', 'base.txt', 'conflict.txt');
  git(seed, 'commit', '-m', 'base');
  git(root, 'clone', '--bare', seed, upstream);
  git(root, 'clone', '--bare', upstream, origin);
  git(root, 'clone', origin, forkRoot);
  git(forkRoot, 'remote', 'add', 'upstream', upstream);
  git(forkRoot, 'switch', '-c', 'local/observation-grounding');
  if (options.conflict) {
    commitFile(forkRoot, 'conflict.txt', 'local edit\n', 'local patch');
  } else {
    commitFile(forkRoot, 'local.txt', 'local patch\n', 'local patch');
  }
  git(forkRoot, 'push', '-u', 'origin', 'local/observation-grounding');
  const oldLocalHead = git(forkRoot, 'rev-parse', 'HEAD');
  git(forkRoot, 'switch', 'main');

  git(root, 'clone', upstream, upstreamWork);
  const upstreamHead = options.conflict
    ? commitFile(upstreamWork, 'conflict.txt', 'upstream edit\n', 'upstream update')
    : commitFile(upstreamWork, 'upstream.txt', 'upstream update\n', 'upstream update');
  git(upstreamWork, 'push', 'origin', 'main');

  mkdirSync(stateDir);
  mkdirSync(hooksDir);
  writeExecutable(join(hooksDir, 'verify'), 'printf "verify\\n" >> "$COMMAND_LOG"');
  writeExecutable(join(hooksDir, 'deploy'), 'printf "deploy\\n" >> "$COMMAND_LOG"');
  writeExecutable(join(hooksDir, 'status'), 'printf "queueDepth=0\\n"');

  return { root, forkRoot, stateDir, hooksDir, commandLog, oldLocalHead, upstreamHead };
}

function maintenanceEnv(fixture: ReturnType<typeof createFixture>): Record<string, string> {
  return {
    CLAUDE_MEM_FORK_ROOT: fixture.forkRoot,
    CLAUDE_MEM_LOCAL_BRANCH: 'local/observation-grounding',
    CLAUDE_MEM_UPSTREAM_REF: 'upstream/main',
    CLAUDE_MEM_STATE_DIR: fixture.stateDir,
    CLAUDE_MEM_VERIFY_HOOK: join(fixture.hooksDir, 'verify'),
    CLAUDE_MEM_DEPLOY_HOOK: join(fixture.hooksDir, 'deploy'),
    CLAUDE_MEM_WORKER_STATUS_HOOK: join(fixture.hooksDir, 'status'),
    COMMAND_LOG: fixture.commandLog,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('claude-mem-local-maintain', () => {
  it('rebases, verifies, pushes, and deploys a clean upstream update', () => {
    const fixture = createFixture();

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, maintenanceEnv(fixture));

    expect(result.exitCode).toBe(0);
    const localHead = git(fixture.forkRoot, 'rev-parse', 'local/observation-grounding');
    expect(git(fixture.forkRoot, 'merge-base', '--is-ancestor', fixture.upstreamHead, localHead)).toBe('');
    expect(git(fixture.forkRoot, 'show', 'local/observation-grounding:local.txt')).toBe('local patch');
    expect(git(fixture.forkRoot, 'rev-parse', 'origin/local/observation-grounding')).toBe(localHead);
    expect(readFileSync(join(fixture.stateDir, 'deployed-commit'), 'utf8').trim()).toBe(localHead);
    expect(readFileSync(fixture.commandLog, 'utf8')).toBe('verify\ndeploy\n');
    expect(git(fixture.forkRoot, 'worktree', 'list')).not.toContain('claude-mem-maintain-candidate');
    expect(existsSync(join(fixture.stateDir, 'last-failure'))).toBe(false);
  });

  it('leaves the branch and deployment untouched when the candidate conflicts', () => {
    const fixture = createFixture({ conflict: true });

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, maintenanceEnv(fixture));

    expect(result.exitCode).toBe(10);
    expect(git(fixture.forkRoot, 'rev-parse', 'local/observation-grounding')).toBe(fixture.oldLocalHead);
    expect(git(fixture.forkRoot, 'rev-parse', 'origin/local/observation-grounding')).toBe(fixture.oldLocalHead);
    expect(existsSync(join(fixture.stateDir, 'deployed-commit'))).toBe(false);
    expect(existsSync(fixture.commandLog)).toBe(false);
    expect(readFileSync(join(fixture.stateDir, 'last-failure'), 'utf8')).toContain('\trebase\t');
  });

  it('leaves the branch and deployment untouched when verification fails', () => {
    const fixture = createFixture();
    writeExecutable(join(fixture.hooksDir, 'verify'), 'printf "verify\\n" >> "$COMMAND_LOG"\nexit 9');

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, maintenanceEnv(fixture));

    expect(result.exitCode).toBe(11);
    expect(git(fixture.forkRoot, 'rev-parse', 'local/observation-grounding')).toBe(fixture.oldLocalHead);
    expect(git(fixture.forkRoot, 'rev-parse', 'origin/local/observation-grounding')).toBe(fixture.oldLocalHead);
    expect(readFileSync(fixture.commandLog, 'utf8')).toBe('verify\n');
    expect(existsSync(join(fixture.stateDir, 'deployed-commit'))).toBe(false);
    expect(readFileSync(join(fixture.stateDir, 'last-failure'), 'utf8')).toContain('\tverify\t');
  });

  it('pushes verified history but defers deployment while the worker queue is busy', () => {
    const fixture = createFixture();
    writeExecutable(join(fixture.hooksDir, 'status'), 'printf "queueDepth=2\\n"');

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, maintenanceEnv(fixture));

    expect(result.exitCode).toBe(20);
    const localHead = git(fixture.forkRoot, 'rev-parse', 'local/observation-grounding');
    expect(localHead).not.toBe(fixture.oldLocalHead);
    expect(git(fixture.forkRoot, 'rev-parse', 'origin/local/observation-grounding')).toBe(localHead);
    expect(readFileSync(fixture.commandLog, 'utf8')).toBe('verify\n');
    expect(existsSync(join(fixture.stateDir, 'deployed-commit'))).toBe(false);
    expect(readFileSync(join(fixture.stateDir, 'last-failure'), 'utf8')).toContain('\tdeploy-deferred\t');
  });

  it('reads queue state from the newest worker log across a date rollover', () => {
    const fixture = createFixture();
    const dataDir = join(fixture.root, 'worker-data');
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'claude-mem-2000-01-01.log'),
      '[2000-01-01 23:59:59.000] [INFO ] [WORKER] Broadcasting processing status {isProcessing=false, queueDepth=0, activeSessions=1}\n'
    );
    const env = maintenanceEnv(fixture);
    delete env.CLAUDE_MEM_WORKER_STATUS_HOOK;
    env.CLAUDE_MEM_DATA_DIR = dataDir;

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, env);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.commandLog, 'utf8')).toBe('verify\ndeploy\n');
  });

  it('does no redundant work when the verified head is already deployed', () => {
    const fixture = createFixture();
    const env = maintenanceEnv(fixture);
    const first = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, env);
    expect(first.exitCode).toBe(0);
    writeFileSync(fixture.commandLog, '');

    const second = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, env);

    expect(second.exitCode).toBe(0);
    expect(readFileSync(fixture.commandLog, 'utf8')).toBe('');
  });

  it('runs the production verify and deploy boundaries when hooks are absent', () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.root, 'fake-bin');
    const dataDir = join(fixture.root, 'data');
    const installedBundle = join(fixture.root, 'installed-worker.cjs');
    mkdirSync(fakeBin);
    mkdirSync(dataDir);
    writeFileSync(installedBundle, 'USER REQUESTS ARE INTENT, NOT EVIDENCE\n<skip_observation />\n');
    writeFileSync(join(dataDir, 'observer-health.json'), '{"consecutiveFailures":0}\n');

    for (const command of ['bun', 'bunx', 'npm', 'python3']) {
      writeExecutable(
        join(fakeBin, command),
        `printf '${command} %s\\n' "$*" >> "$COMMAND_LOG"`
      );
    }
    writeExecutable(
      join(fakeBin, 'codex'),
      'printf "codex %s\\n" "$*" >> "$COMMAND_LOG"\nprintf "{\\"status\\":\\"installed\\"}\\n"'
    );
    writeExecutable(join(fakeBin, 'curl'), 'printf "{\\"status\\":\\"ok\\"}\\n"');

    const env = maintenanceEnv(fixture);
    delete env.CLAUDE_MEM_VERIFY_HOOK;
    delete env.CLAUDE_MEM_DEPLOY_HOOK;
    env.PATH = `${fakeBin}:${process.env.PATH}`;
    env.CLAUDE_MEM_CACHEBUSTER_HELPER = join(fixture.root, 'cachebuster.py');
    env.CLAUDE_MEM_INSTALLED_WORKER_BUNDLE = installedBundle;
    env.CLAUDE_MEM_DATA_DIR = dataDir;

    const result = run(['/bin/bash', SCRIPT, '--apply'], fixture.forkRoot, env);

    expect(result.exitCode).toBe(0);
    const commandLog = readFileSync(fixture.commandLog, 'utf8');
    expect(commandLog).toContain('bun install --frozen-lockfile');
    expect(commandLog).toContain('bun test tests/sdk/prompts.test.ts');
    expect(commandLog).toContain('bunx tsc --noEmit');
    expect(commandLog).toContain('npm run build');
    expect(commandLog).toContain('python3');
    expect(commandLog).toContain('npm run sync-marketplace');
    expect(commandLog).toContain('codex plugin add claude-mem@claude-mem-local --json');
    expect(commandLog).toContain('npm run worker:restart');
  });
});
