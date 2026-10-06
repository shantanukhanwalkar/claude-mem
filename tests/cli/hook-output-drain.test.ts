import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A forced exit before stdout drains loses the end of the JSON envelope.
// Exercise the real subprocess and pipe, without a worker or provider call.
const hasLinuxPipeHarness = process.platform === 'linux'
  && spawnSync('python3', ['--version']).status === 0;
test.skipIf(!hasLinuxPipeHarness)('graceful hook exit delivers complete JSON larger than pipe capacity', () => {
  const modulePath = fileURLToPath(new URL('../../src/shared/hook-io.ts', import.meta.url));
  const script = `
    import { emitModelContext, exitGraceful } from ${JSON.stringify(modulePath)};
    // Worker dependencies initialize Node-compatible stdout. This switches
    // Bun's console.log away from its otherwise synchronous native path.
    void process.stdout;
    async function main() {
    const completion = emitModelContext({ formatOutput: result => result }, {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory 🧠\\n'.repeat(200000) }
    });
    // The old synchronous emitter supplies no completion to wait for.
    // Avoid an artificial await(undefined) that lets Bun flush by accident.
    if (completion) await completion;
    exitGraceful();
    }
    main();
  `;
  // Python creates an OS pipe; Node/Bun child_process may use socket pairs,
  // which do not reproduce the installed hook's Linux pipe truncation.
  const reader = `
import json, subprocess, sys, time
child = subprocess.Popen([sys.argv[1], '--eval', sys.argv[2]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(0.1)
stdout, stderr = child.communicate(timeout=5)
complete = False
try:
    parsed = json.loads(stdout)
    complete = stdout.endswith(b'\\n') and parsed['hookSpecificOutput'] == {'hookEventName': 'SessionStart', 'additionalContext': 'memory 🧠\\n' * 200000}
except (ValueError, KeyError):
    pass
print(json.dumps({'status': child.returncode, 'stderr': stderr.decode(), 'complete': complete}))
  `;
  const result = spawnSync('python3', ['-c', reader, process.execPath, script], {
    encoding: 'utf8', timeout: 8000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    status: 0, stderr: '', complete: true,
  });
}, 10000);
