# Startup hook stdout repair — 2026-09-08

The installed Codex SessionStart command intermittently returned exit 0 with
exactly 8192 bytes of truncated JSON. Five consecutive piped reproductions
failed JSON parsing. The complete current context envelope is 9904 bytes.

Once a dependency initializes Node-compatible `process.stdout`, Bun 1.3.10's
`console.log` can leave bytes buffered when the hook calls `process.exit(0)`.
The emitter now writes its JSON plus newline through `process.stdout.write`
and returns a completion promise. All three hook pipeline emit sites await
that promise before exit, including input-rejection no-op envelopes.

The regression uses an actual OS pipe and delayed reader, with stdout
initialized before emission. It fails with the original emitter and passes
with the repaired emitter. The focused hook suite passes 52 tests; root and
viewer type checks and the plugin build pass. Built startup commands return
complete JSON exceeding the former 8192-byte truncation boundary.

This is a hook-only installation update at base version 13.24.2-local.2.
The existing daemon is deliberately retained: its in-memory queue contains
over 1300 events. The deployment receipt records the installed bundle hash
and the retained daemon's pre-update identity separately. No provider,
quota threshold, database, or queue settings are changed.

Memory capture is independently paused by the local subscription guard:
the latest weekly utilization is 97%, exceeding its 93% reserve threshold.
The provider status is `allowed_warning`; the generic observer-health text
"inference allowance exhausted" does not distinguish this local reserve
from provider rejection. The reported weekly reset is September 8 at
21:30 IST. Existing memory retrieval remains available during the pause.
