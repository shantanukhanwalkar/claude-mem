# HAR-977: stable maintained claude-mem

Approved scope: user accepted the investigation's recommended repair and requested implementation and a Jira ticket. Ticket: https://tattvi.atlassian.net/browse/HAR-977 (In Progress), related HAR-947.

Goal: preserve useful Sonnet-backed memory capture from Claude and Codex without extra condensation inference, stale quota lockout, or installation drift.

Constraints: retain Claude CLI/OAuth and Sonnet 4.5; preserve database and queue; honor real provider limits; pin a reviewed upstream release; do not automatically adopt new upstream commits. Baseline upstream v13.24.1. Worktree /home/sk/worktrees/claude-mem-stability, branch fix/local-stability-2026-09-07.

- [x] Create Jira issue with evidence and acceptance criteria; verify upstream baseline tests (59 passed).
- [ ] Restore personal grounding and explicit skip protocol, preserving newer upstream semantics. Tests must fail before restoration and pass after; review batch acknowledgement and init-only behavior.
- [ ] Replace oversized-field model condensation with deterministic bounded truncation. Regression: no extra model calls for any oversized field; preserve visible evidence and elision markers.
- [ ] Fix quota-store freshness with the captured snapshot regression, valid unified windows, seconds/ms expiry, malformed data, and genuine rejection protection.
- [ ] Pin and audit installation: one canonical maintained build, coherent manifest/runtime version, matching Claude/Codex worker hashes, upstream auto-update disabled, daily audit instead of unattended upstream rebases/deployment. Retain rollback snapshot and document explicit update procedure.
- [ ] Run focused tests, type checks, build, independent review; resolve findings. Commit source and built artifacts in the durable fork.
- [ ] Deploy and restart corrected worker preserving pending work/cooldowns. Verify same build through both integrations, successful real observation capture and retrieval, bounded inference activity, and stability across hook events.
- [ ] Update Jira and provider/runbook records with exact verification and any remaining limits.

Progress evidence lives in /home/sk/tmp/claude-mem-*-report.md and /home/sk/tmp/claude-mem-*-tests.log. Independent quota and payload implementers own disjoint files. Root owns integration, grounding, Jira, deployment and live validation. No approval pause is required: the user explicitly requested fixing the installed service.
