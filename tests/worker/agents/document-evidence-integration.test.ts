import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const kind of ['processor', 'controls', 'storage-error', 'sdk-lifecycle', 'sdk-model-evidence-reported', 'sdk-model-evidence-absent', 'sdk-storage-error', 'sdk-optimized', 'recovery', 'sdk-shutdown', 'sdk-provider-switch', 'sdk-auth', 'sdk-quota', 'escaped-history']) {
  it(`document evidence integration: ${kind}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'document-evidence-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Sticky module mocks, fixture telemetry, settings and SDK ownership stay in this process.
      child = Bun.spawn([process.execPath, 'tests/fixtures/worker/document-evidence-lifecycle.ts', kind], {
        cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
      });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Document evidence fixture exceeded 12 seconds')), 12000);
      })]);
      expect(exitCode, (await output).join('\n')).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15000);
}
