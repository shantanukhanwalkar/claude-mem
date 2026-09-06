import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'audit-local-install.cjs');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '13.24.2-local.1';
const WORKER = 'stable worker bundle\n';
const WORKER_SHA256 = createHash('sha256').update(WORKER).digest('hex');

type Fixture = {
  root: string;
  receiptPath: string;
  installationRoots: Record<'claude' | 'codex' | 'marketplace', string>;
  knownMarketplacesPath: string;
  installedPluginsPath: string;
  claudeSettingsPath: string;
};

const roots: string[] = [];

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function json(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-install-audit-'));
  roots.push(root);

  const installationRoots = {
    claude: join(root, 'claude'),
    codex: join(root, 'codex'),
    marketplace: join(root, 'marketplace'),
  };

  for (const [name, installRoot] of Object.entries(installationRoots)) {
    json(join(installRoot, 'package.json'), { name: 'claude-mem-plugin', version: VERSION });
    const manifestDirectory = name === 'codex' ? '.codex-plugin' : '.claude-plugin';
    const manifestVersion = name === 'codex' ? `${VERSION}+codex.local` : VERSION;
    json(join(installRoot, manifestDirectory, 'plugin.json'), {
      name: 'claude-mem',
      version: manifestVersion,
    });
    write(join(installRoot, 'scripts', 'worker-service.cjs'), WORKER);
  }

  const knownMarketplacesPath = join(root, '.claude', 'plugins', 'known_marketplaces.json');
  json(knownMarketplacesPath, {
    thedotmack: {
      source: {
        source: 'github',
        repo: 'shantanukhanwalkar/claude-mem',
        ref: 'local/stable',
      },
      installLocation: join(root, 'marketplace-root'),
      autoUpdate: false,
    },
  });
  const installedPluginsPath = join(root, '.claude', 'plugins', 'installed_plugins.json');
  json(installedPluginsPath, {
    version: 2,
    plugins: {
      'claude-mem@thedotmack': [
        {
          scope: 'user',
          installPath: installationRoots.claude,
          version: VERSION,
          installedAt: '2026-09-07T00:00:00.000Z',
          lastUpdated: '2026-09-07T00:00:00.000Z',
        },
      ],
    },
  });
  const claudeSettingsPath = join(root, '.claude', 'settings.json');
  json(claudeSettingsPath, {
    extraKnownMarketplaces: {
      thedotmack: {
        source: {
          source: 'github',
          repo: 'shantanukhanwalkar/claude-mem',
          ref: 'local/stable',
        },
        autoUpdate: false,
      },
    },
  });

  const receiptPath = join(root, 'deployment.json');
  json(receiptPath, {
    schemaVersion: 1,
    version: VERSION,
    commit: COMMIT,
    workerSha256: WORKER_SHA256,
    installationRoots,
    knownMarketplacesPath,
  });

  return {
    root,
    receiptPath,
    installationRoots,
    knownMarketplacesPath,
    installedPluginsPath,
    claudeSettingsPath,
  };
}

function snapshotTree(root: string, relative = ''): unknown[] {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const entryRelative = join(relative, entry.name);
      const entryPath = join(root, entryRelative);
      const stat = statSync(entryPath);
      const record = {
        path: entryRelative,
        kind: entry.isDirectory() ? 'directory' : 'file',
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        contents: entry.isFile() ? readFileSync(entryPath).toString('base64') : undefined,
      };
      return entry.isDirectory()
        ? [record, ...snapshotTree(root, entryRelative)]
        : [record];
    });
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('auditLocalInstall', () => {
  it('accepts matching installations and Codex build metadata', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();

    const result = auditLocalInstall(fixture.receiptPath);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.version).toBe(VERSION);
    expect(result.commit).toBe(COMMIT);
    expect(result.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
  });

  it('rejects a worker bundle replaced after deployment', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();
    write(
      join(fixture.installationRoots.marketplace, 'scripts', 'worker-service.cjs'),
      'upstream replacement\n',
    );

    const result = auditLocalInstall(fixture.receiptPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('marketplace worker SHA-256 mismatch');
    expect(result.errors.join('\n')).toContain(WORKER_SHA256);
  });

  it('rejects package and manifest version drift in every installation kind', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const cases = [
      { rootName: 'claude', file: 'package.json', expected: 'claude package version mismatch' },
      { rootName: 'marketplace', file: '.claude-plugin/plugin.json', expected: 'marketplace manifest version mismatch' },
      { rootName: 'codex', file: '.codex-plugin/plugin.json', expected: 'codex manifest version mismatch' },
    ] as const;

    for (const testCase of cases) {
      const fixture = makeFixture();
      const installRoot = fixture.installationRoots[testCase.rootName];
      const target = join(installRoot, testCase.file);
      const document = JSON.parse(readFileSync(target, 'utf8'));
      document.version = '99.0.0';
      json(target, document);

      const result = auditLocalInstall(fixture.receiptPath);

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(testCase.expected);
    }
  });

  it('requires thedotmack marketplace auto-updates to be explicitly disabled', async () => {
    const { auditLocalInstall } = await import(SCRIPT);

    for (const autoUpdate of [true, undefined]) {
      const fixture = makeFixture();
      const entry: Record<string, unknown> = {
        source: { source: 'github', repo: 'thedotmack/claude-mem' },
      };
      if (autoUpdate !== undefined) entry.autoUpdate = autoUpdate;
      json(fixture.knownMarketplacesPath, { thedotmack: entry });

      const result = auditLocalInstall(fixture.receiptPath);

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(
        'known_marketplaces.json thedotmack.autoUpdate must be explicitly false',
      );
    }
  });

  it('rejects a Claude settings override that re-enables marketplace auto-update', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();
    const settings = JSON.parse(readFileSync(fixture.claudeSettingsPath, 'utf8'));
    settings.extraKnownMarketplaces.thedotmack.autoUpdate = true;
    json(fixture.claudeSettingsPath, settings);

    const result = auditLocalInstall(fixture.receiptPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'settings.json extraKnownMarketplaces.thedotmack.autoUpdate must be explicitly false',
    );
  });

  it('rejects a Claude settings marketplace source that disagrees with the registered source', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();
    const settings = JSON.parse(readFileSync(fixture.claudeSettingsPath, 'utf8'));
    settings.extraKnownMarketplaces.thedotmack.source.repo = 'thedotmack/claude-mem';
    settings.extraKnownMarketplaces.thedotmack.source.ref = 'main';
    json(fixture.claudeSettingsPath, settings);

    const result = auditLocalInstall(fixture.receiptPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'settings.json extraKnownMarketplaces.thedotmack.source.repo mismatch',
    );
    expect(result.errors.join('\n')).toContain(
      'settings.json extraKnownMarketplaces.thedotmack.source.ref mismatch',
    );
  });

  it('allows no settings declaration but rejects a malformed settings file', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const absentDeclaration = makeFixture();
    json(absentDeclaration.claudeSettingsPath, { theme: 'dark' });
    expect(auditLocalInstall(absentDeclaration.receiptPath).ok).toBe(true);

    const malformed = makeFixture();
    write(malformed.claudeSettingsPath, '{bad json');
    const malformedResult = auditLocalInstall(malformed.receiptPath);
    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.errors.join('\n')).toContain('Claude settings.json is not valid JSON');
  });

  it('rejects preserved receipt files when Claude registers a different active install', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();
    json(fixture.installedPluginsPath, {
      version: 2,
      plugins: {
        'claude-mem@thedotmack': [
          {
            scope: 'user',
            installPath: join(fixture.root, 'newer-claude-cache'),
            version: '13.24.3',
          },
        ],
      },
    });

    const result = auditLocalInstall(fixture.receiptPath);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('active Claude install path mismatch');
    expect(result.errors.join('\n')).toContain(fixture.installationRoots.claude);
    expect(result.errors.join('\n')).toContain('active Claude version mismatch');
  });

  it('returns actionable failures for missing and corrupt receipts', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-install-audit-'));
    roots.push(root);
    const receiptPath = join(root, 'deployment.json');

    const missing = auditLocalInstall(receiptPath);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join('\n')).toContain('deployment receipt is missing');

    write(receiptPath, '{broken json');
    const corrupt = auditLocalInstall(receiptPath);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.errors.join('\n')).toContain('deployment receipt is not valid JSON');
  });

  it('rejects receipts without complete, valid provenance fields', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const cases = [
      { field: 'schemaVersion', value: 2, expected: 'schemaVersion must be 1' },
      { field: 'version', value: '', expected: 'version must be a non-empty string' },
      { field: 'commit', value: 'short', expected: 'commit must be a full 40-hex Git commit' },
      { field: 'workerSha256', value: 'bad', expected: 'workerSha256 must be a 64-hex SHA-256' },
      { field: 'knownMarketplacesPath', value: '', expected: 'knownMarketplacesPath must be a non-empty string' },
      { field: 'installedPluginsPath', value: '', expected: 'installedPluginsPath must be a non-empty string' },
      { field: 'claudeSettingsPath', value: '', expected: 'claudeSettingsPath must be a non-empty string' },
    ] as const;

    for (const testCase of cases) {
      const fixture = makeFixture();
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
      receipt[testCase.field] = testCase.value;
      json(fixture.receiptPath, receipt);

      const result = auditLocalInstall(fixture.receiptPath);

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(testCase.expected);
    }

    const fixture = makeFixture();
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
    delete receipt.installationRoots.codex;
    json(fixture.receiptPath, receipt);
    const result = auditLocalInstall(fixture.receiptPath);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('installationRoots.codex must be a non-empty string');
  });

  it('reports missing or malformed installed files without throwing', async () => {
    const { auditLocalInstall } = await import(SCRIPT);

    const missingBundle = makeFixture();
    const workerPath = join(
      missingBundle.installationRoots.claude,
      'scripts',
      'worker-service.cjs',
    );
    unlinkSync(workerPath);
    const missingBundleResult = auditLocalInstall(missingBundle.receiptPath);
    expect(missingBundleResult.ok).toBe(false);
    expect(missingBundleResult.errors.join('\n')).toContain('claude worker bundle is missing');

    const corruptManifest = makeFixture();
    write(
      join(corruptManifest.installationRoots.codex, '.codex-plugin', 'plugin.json'),
      '{bad json',
    );
    const corruptManifestResult = auditLocalInstall(corruptManifest.receiptPath);
    expect(corruptManifestResult.ok).toBe(false);
    expect(corruptManifestResult.errors.join('\n')).toContain('codex manifest is not valid JSON');

    const missingConfig = makeFixture();
    unlinkSync(missingConfig.knownMarketplacesPath);
    const missingConfigResult = auditLocalInstall(missingConfig.receiptPath);
    expect(missingConfigResult.ok).toBe(false);
    expect(missingConfigResult.errors.join('\n')).toContain('known_marketplaces.json is missing');

    const corruptConfig = makeFixture();
    write(corruptConfig.knownMarketplacesPath, '{bad json');
    const corruptConfigResult = auditLocalInstall(corruptConfig.receiptPath);
    expect(corruptConfigResult.ok).toBe(false);
    expect(corruptConfigResult.errors.join('\n')).toContain('known_marketplaces.json is not valid JSON');
  });

  it('requires readable installed plugin metadata with a user-scoped entry', async () => {
    const { auditLocalInstall } = await import(SCRIPT);

    const missing = makeFixture();
    unlinkSync(missing.installedPluginsPath);
    const missingResult = auditLocalInstall(missing.receiptPath);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join('\n')).toContain('installed_plugins.json is missing');

    const corrupt = makeFixture();
    write(corrupt.installedPluginsPath, '{bad json');
    const corruptResult = auditLocalInstall(corrupt.receiptPath);
    expect(corruptResult.ok).toBe(false);
    expect(corruptResult.errors.join('\n')).toContain('installed_plugins.json is not valid JSON');

    const noUserEntry = makeFixture();
    json(noUserEntry.installedPluginsPath, {
      version: 2,
      plugins: {
        'claude-mem@thedotmack': [
          { scope: 'project', installPath: noUserEntry.installationRoots.claude, version: VERSION },
        ],
      },
    });
    const noUserEntryResult = auditLocalInstall(noUserEntry.receiptPath);
    expect(noUserEntryResult.ok).toBe(false);
    expect(noUserEntryResult.errors.join('\n')).toContain(
      'installed_plugins.json has no user-scoped claude-mem@thedotmack entry',
    );
  });

  it('verifies an optional source checkout commit and built worker hash', async () => {
    const { auditLocalInstall } = await import(SCRIPT);
    const fixture = makeFixture();
    const sourceRoot = join(fixture.root, 'source');
    const sourceWorker = join(sourceRoot, 'plugin', 'scripts', 'worker-service.cjs');
    write(sourceWorker, WORKER);
    execFileSync('git', ['init', '-q'], { cwd: sourceRoot });
    execFileSync('git', ['add', '.'], { cwd: sourceRoot });
    execFileSync(
      'git',
      ['-c', 'user.name=Audit Test', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture'],
      { cwd: sourceRoot },
    );
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8'));
    receipt.sourceRoot = sourceRoot;
    receipt.commit = commit;
    json(fixture.receiptPath, receipt);

    expect(auditLocalInstall(fixture.receiptPath).ok).toBe(true);

    write(sourceWorker, 'different source bundle\n');
    const workerDrift = auditLocalInstall(fixture.receiptPath);
    expect(workerDrift.ok).toBe(false);
    expect(workerDrift.errors.join('\n')).toContain('source worker SHA-256 mismatch');

    write(sourceWorker, WORKER);
    write(join(sourceRoot, 'later.txt'), 'later commit\n');
    execFileSync('git', ['add', '.'], { cwd: sourceRoot });
    execFileSync(
      'git',
      ['-c', 'user.name=Audit Test', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'later'],
      { cwd: sourceRoot },
    );
    const commitDrift = auditLocalInstall(fixture.receiptPath);
    expect(commitDrift.ok).toBe(false);
    expect(commitDrift.errors.join('\n')).toContain('source Git commit mismatch');
  });
});

describe('audit-local-install CLI', () => {
  it('prints a clear success summary and uses the default receipt path', () => {
    const fixture = makeFixture();
    const defaultReceiptPath = join(
      fixture.root,
      '.local',
      'state',
      'claude-mem-maintenance',
      'deployment.json',
    );
    write(defaultReceiptPath, readFileSync(fixture.receiptPath, 'utf8'));

    const result = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-mem local installation audit passed');
    expect(result.stdout).toContain(`version ${VERSION}`);
    expect(result.stdout).toContain(COMMIT);
    expect(result.stdout).toContain('16 checks passed');
    expect(result.stderr).toBe('');
  });

  it('exits nonzero with actionable drift output and does not mutate inputs', () => {
    const fixture = makeFixture();
    write(
      join(fixture.installationRoots.codex, 'scripts', 'worker-service.cjs'),
      'overwritten worker\n',
    );
    const before = snapshotTree(fixture.root);

    const result = spawnSync('node', [SCRIPT, fixture.receiptPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('claude-mem local installation audit failed');
    expect(result.stderr).toContain('codex worker SHA-256 mismatch');
    expect(result.stderr).toContain('redeploy from the recorded source and replace this receipt');
    expect(result.stdout).toBe('');
    expect(snapshotTree(fixture.root)).toEqual(before);
  });
});
