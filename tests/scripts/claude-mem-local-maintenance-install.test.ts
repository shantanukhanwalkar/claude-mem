import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dir, '../..');
const INSTALLER = join(ROOT, 'ops/local-maintenance/install.sh');
const tempRoots: string[] = [];

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('claude-mem local maintenance installer', () => {
  it('installs the maintainer and persistent daily user timer', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-maintain-install-'));
    tempRoots.push(tempRoot);
    const systemdDir = join(tempRoot, 'systemd');
    const localBinDir = join(tempRoot, 'bin');
    const fakeBin = join(tempRoot, 'fake-bin');
    const commandLog = join(tempRoot, 'systemctl.log');
    mkdirSync(systemdDir);
    mkdirSync(localBinDir);
    mkdirSync(fakeBin);
    writeExecutable(join(fakeBin, 'systemctl'), 'printf "%s\\n" "$*" >> "$COMMAND_LOG"');

    const result = Bun.spawnSync(['/bin/bash', INSTALLER], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        COMMAND_LOG: commandLog,
        CLAUDE_MEM_SOURCE_ROOT: ROOT,
        SYSTEMD_USER_DIR: systemdDir,
        LOCAL_BIN_DIR: localBinDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    const installedMaintainer = join(localBinDir, 'claude-mem-local-maintain');
    expect(statSync(installedMaintainer).mode & 0o777).toBe(0o755);
    expect(readFileSync(installedMaintainer, 'utf8')).toBe(
      readFileSync(join(ROOT, 'scripts/claude-mem-local-maintain.sh'), 'utf8')
    );

    const service = readFileSync(join(systemdDir, 'claude-mem-local-maintenance.service'), 'utf8');
    expect(service).toContain(`ExecStart=${installedMaintainer} --apply`);
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('TimeoutStartSec=45min');

    const timer = readFileSync(join(systemdDir, 'claude-mem-local-maintenance.timer'), 'utf8');
    expect(timer).toContain('OnCalendar=*-*-* 04:15:00 Asia/Kolkata');
    expect(timer).toContain('RandomizedDelaySec=15m');
    expect(timer).toContain('Persistent=true');

    expect(readFileSync(commandLog, 'utf8')).toBe(
      '--user daemon-reload\n--user enable --now claude-mem-local-maintenance.timer\n'
    );
  });
});
