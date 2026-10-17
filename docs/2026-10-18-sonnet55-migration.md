# HAR-947: Sonnet 5.5 qualification

Status: the compatibility and Chroma source changes passed independent review. Release candidate `13.32.1-local.2` also clarifies shared observation grounding after a diagnostic reproduced an unsupported completion claim on both model generations. Targeted grounding regressions and independent source review passed; the complete-source workload evaluation, installation, and live capture verification remain separate gates. This document does not attest that a release was installed.

## Official compatibility facts checked 2026-10-18

Anthropic lists Sonnet 4.5 retirement on the Claude API for November 30, 2026, with `claude-sonnet-5-5` as the recommended replacement. This is an API retirement notice, not proof of a Claude Code subscription cutoff. [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).

The API migration guide accepts adaptive thinking and `between_tools` for Sonnet 5.5, rejects `disabled` and fixed thinking budgets, and recommends explicit effort. Responses may include thinking blocks before text; usage includes thinking output. [Migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).

Claude Code requires version 2.1.284 or later for Sonnet 5.5 and defaults its effort to medium. Its CLI behavior is a distinct compatibility boundary from raw API options. [Model configuration](https://code.claude.com/docs/en/model-config).

## Maintained implementation

Qualification starts from `local/stable` commit `b90bbbfb0fba798095b3561efe0a7c636b2a4391`, version `13.32.1-local.1`, upstream baseline v13.32.0. Initial isolated qualification used the available `@anthropic-ai/claude-agent-sdk` 0.3.252. Inspection of the deployed baseline bundle then identified SDK 0.3.291 and its preserved October 6 build dependency tree. The release candidate pins 0.3.291 exactly, replacing the baseline range `^0.3.172`, and rebuilds from that original tree to avoid incidental library downgrades. Both SDK versions expose `thinking` and `effort`, but not `between_tools`; release checks exercise the 0.3.291 serialization path. Do not cast unsupported API fields into this SDK.

`buildHardenedSdkOptions` gives Observer calls with the explicit model ID `claude-sonnet-5-5` adaptive thinking and medium effort. Other model IDs retain disabled thinking without effort; KnowledgeAgent retains its existing behavior. Use the explicit pin: the moving `sonnet` alias does not select this policy. Tier aliases already resolve before the helper and need no special migration rewrite.

The same helper serves the primary observation/summary stream and standalone Observer calls. Oversized-field condensation receives the primary session's selected model. Telegram wrap-up formatting can select a separate summary-tier model; with no configured summary override it falls back to the current model. The source again permits bounded condensation, so the old claim that no condensation calls occur is obsolete.

All tool, permission, cwd, settings, and MCP restrictions remain in the shared helper. Environment sanitization continues stripping inherited CLI effort controls. Queue, quota, payload, and conversation limits remain unchanged; no automatic 1M context expansion is introduced.

## Exact SDK-to-CLI qualification

Two isolated calls used the source SDK helper, existing OAuth credentials, resolved `/home/sk/.local/bin/claude` (Claude Code 2.1.302), the production spawn factory, empty tools, and `--no-session-persistence`. Their cwd and claude-mem data directory were private. They did not write production memory or restart the worker.

Both the old `disabled` policy and the new adaptive/medium policy returned assistant model `claude-sonnet-5-5`, text `HAR947_OK`, empty initialized tools, and a successful terminal result. The old CLI path did **not** reproduce the raw API's invalid-thinking error; the CLI handles that legacy control. The new policy removes dependence on this translation and pins effort explicitly.

Each terminal result reported Sonnet input 2, cache creation 580, output 9, thinking 0. Each also reported an internal Haiku 5.5 entry (input 1,178, output 16). The combined list-price estimate was $0.0025398 per top-level call; this is not measured subscription spend. These tiny calls prove request compatibility, not workload quality or future usage savings.

Private evidence: `~/.local/state/claude-mem-maintenance/har947-compat/{baseline,adaptive-medium}.json` records full model usage, returned assistant model, safe argv, and guard snapshot. It contains no credentials. No further qualification inference is needed before the separately bounded paired workload evaluation.

## Retrieval launcher repair

The independent retrieval preflight found MCP 1.6.0 importing the private Pydantic `eval_type_backport` symbol removed in the resolved Pydantic 2.14.1 environment. Adding `pydantic==2.12.5` to the existing uvx dependency overrides restores the locally qualified combination. The existing `chroma-mcp==0.2.6`, `chromadb==1.5.9`, onnxruntime floor, and protobuf cap remain unchanged. The shared override list applies to both persistent and HTTP launch modes and is recorded in crash/store provenance.

An isolated temporary store passed MCP initialization, 13-tool discovery, collection creation, add, get, and query with that exact launcher pin. The production database was not opened. Private evidence is `~/.local/state/claude-mem-maintenance/har947-chroma-proof/protocol-and-retrieval.json` and `proof-summary.json`. This does not prove live retrieval recovery; install the reviewed bundle and verify it after restart.

## Shared grounding diagnostic

A fresh replay of a link-and-readback operation produced an unsupported "Created" claim on both Sonnet 4.5 and Sonnet 5.5. The operation linked an existing issue and read its state; it did not create that issue. In the original chronological session an earlier tool did create it, so this isolated failure does not by itself prove a false production completion. A two-turn replay with that earlier creation changed the result: Sonnet 5.5 described the linking delta correctly, while Sonnet 4.5 anticipated links in its creation observation and skipped the later delta. This is a shared grounding ambiguity, not an established Sonnet 5.5-specific regression.

The shared observation prompt now requires titles, facts, and narratives to distinguish current confirmed actions from requests, plans, and existing-state readbacks. Earlier verified work may supply background without being claimed as newly completed. Readbacks can still support durable discoveries. File metadata requires tool evidence of actual reads or changes, rather than paths merely mentioned in an issue or plan. The original failed live fixtures supply the behavioral regression cases; existing prompt tests check the surrounding rendering and skip contracts. Independent review approved the clarification. A bounded fresh replay of the original link/readback case with the final prompt, exact deployed SDK 0.3.291 and CLI 2.1.302 passed on both model generations: actual response models were `claude-sonnet-4-5-20250929` and `claude-sonnet-5-5`, terminal results succeeded, neither claimed issue creation, and both left file lists empty. This targeted regression does not replace the complete-source workload quality gate before model activation.

Private evidence: `~/.local/state/claude-mem-maintenance/har947-evaluation-20261018/diagnostic-{baseline,candidate}-{fresh-repeat,context}.json`, `diagnostic-protocol.json`, and `exact-runtime-regression-{baseline,candidate}.json`. The initial mixed-snapshot full test run was interrupted without a terminal summary. Eight of its ten observed failures reproduce on unchanged base; two full-suite-order/timing failures remain unattributed. No full-suite pass is claimed.

## Release and installation requirements

1. Review the source/test diff and workload evaluation. The tests must prove thinking/effort reach CLI argv, preserve tool lockdown and legacy/KnowledgeAgent behavior, and cover observations, standalone formatting, and condensation, including text after thinking blocks.
2. Choose a new coherent local version, update all manifests, and regenerate bundles/locks with the qualified SDK. Re-run tests, root/viewer type checks, and `npm run build`; do not use `build-and-sync` for isolated verification.
3. Back up the receipt, provider/settings metadata, installation roots and database consistently. Drain the RAM queue or archive source transcripts for its pending interval. Preserve quota/cooldown state. Follow the [local stable runbook](local-stable-runbook.md).
4. Install reviewed bytes to all receipt roots, use a fresh Codex cachebuster where needed, pin the intended observer/tier models, and verify hashes/version before an authorized API restart. Retain OAuth authentication and keep automatic upstream updates disabled as configured.
5. Verify readiness plus a new observation captured and retrieved. Confirm actual assistant model provenance, useful grounded output, bounded condensation, and quota/cooldown behavior; a health response or configured/database model tag alone is insufficient.

Preserve the general 95% weekly guard and any stricter Sonnet-specific guard (currently 92%). Repeat fresh allowance checks before evaluation or live canaries and stop on a Claude cooldown. Rollback restores reviewed prior installation/settings/receipt through the runbook without replacing newly captured memory with an old database.
