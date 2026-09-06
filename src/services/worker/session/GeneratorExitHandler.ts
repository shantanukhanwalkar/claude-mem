import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
}

/**
 * Post-generator-exit handler.
 *
 * The generator's message iterator only ends on abort (idle / shutdown) or when
 * the SDK stream throws, so most exits mean this session is done. Quota exits
 * and interrupted stream exits are different: claimed work has already been
 * reset to pending, so leave the session and in-RAM buffer alive for a later
 * generator start.
 *
 * For non-quota exits we do NOT respawn on remaining buffered work: the old
 * respawn-on-pending loop, driven by the durable pending_messages queue, was the
 * retry storm. Buffered work lives only in RAM now; anything still buffered is
 * dropped here and recovered, if needed, by replaying the Claude Code
 * transcript. Continuation of a session that is still live happens naturally —
 * the next observation ingest calls ensureGeneratorRunning, which starts a
 * fresh generator that drains whatever is buffered.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  // 'overflow' and 'stream' join quota/auth as pause-and-preserve exits. The
  // claimed batch is already pending again, so the session must survive for a
  // later ingest to open a fresh generator and drain it. Only overflow:recycle
  // is restarted automatically by SessionRoutes; stream failures stay paused.
  const abortCategory = (reason ?? '').split(':')[0];
  if (
    abortCategory === 'quota' ||
    abortCategory === 'auth' ||
    abortCategory === 'overflow' ||
    abortCategory === 'stream'
  ) {
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
    });
    return;
  }

  logger.info('SESSION', 'Generator exited — finalizing session', { sessionId: sessionDbId, reason });

  try {
    await completionHandler.finalizeSession(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Finalization failed; forcing in-memory session removal', {
      sessionId: sessionDbId,
      reason
    }, normalized);
  } finally {
    sessionManager.removeSessionImmediate(sessionDbId);
  }
}
