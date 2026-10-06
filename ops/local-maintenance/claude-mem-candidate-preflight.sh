#!/usr/bin/env bash
# claude-mem-candidate-preflight.sh — read-only preconditions for adopting a
# candidate build into the live claude-mem installation (HAR-1103).
#
# Usage:
#   claude-mem-candidate-preflight.sh --check --candidate <worktree> --commit <sha> \
#       [--expect-version <x.y.z-local.n>] [--worker-sha <sha256>] [--ctx-sha <sha256>] \
#       [--allow-queue]
#
# Writes nothing. Exits 0 when every precondition holds, 1 when at least one
# fails, 2 on usage error. Every check prints PASS/FAIL with the observed value,
# so a failure names what to fix. Each check can fail for the reason it exists:
# run it on a day with a non-empty queue or a missing settings key to see it.
set -uo pipefail

HOST_SRC=/home/sk/development/tools/claude-mem
RECEIPT="${CLAUDE_MEM_RECEIPT:-$HOME/.local/state/claude-mem-maintenance/deployment.json}"
SETTINGS="${CLAUDE_MEM_SETTINGS:-$HOME/.claude-mem/settings.json}"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
BACKUPS="$HOME/.local/state/claude-mem-maintenance/backups"
WORKER_URL="${CLAUDE_MEM_WORKER_URL:-http://127.0.0.1:37777}"
THRESHOLD_KEY=CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY
THRESHOLD_VALUE=0.95

MODE=""; CANDIDATE=""; COMMIT=""; EXPECT_VERSION=""; WORKER_SHA=""; CTX_SHA=""; ALLOW_QUEUE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --candidate) CANDIDATE="$2"; shift ;;
    --commit) COMMIT="$2"; shift ;;
    --expect-version) EXPECT_VERSION="$2"; shift ;;
    --worker-sha) WORKER_SHA="$2"; shift ;;
    --ctx-sha) CTX_SHA="$2"; shift ;;
    --allow-queue) ALLOW_QUEUE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$MODE" = check ] || { echo "only --check is implemented; this script never applies" >&2; exit 2; }
[ -n "$CANDIDATE" ] && [ -n "$COMMIT" ] || { echo "--candidate and --commit are required" >&2; exit 2; }

fails=0
pass() { printf 'PASS %-34s %s\n' "$1" "$2"; }
fail() { printf 'FAIL %-34s %s\n' "$1" "$2"; fails=$((fails+1)); }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null; }
http_json() { curl -s -m 5 "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$2" 2>/dev/null; }

# 1. Host checkout untouched: HEAD equals the receipt commit, tree clean.
receipt_commit=$(json "$RECEIPT" "d['commit']")
host_head=$(git -C "$HOST_SRC" rev-parse HEAD 2>/dev/null)
host_dirty=$(git -C "$HOST_SRC" status --porcelain 2>/dev/null | wc -l)
if [ -n "$receipt_commit" ] && [ "$host_head" = "$receipt_commit" ] && [ "$host_dirty" -eq 0 ]; then
  pass host-checkout "HEAD ${host_head:0:9} == receipt, clean"
else
  fail host-checkout "HEAD ${host_head:0:9} receipt ${receipt_commit:0:9} dirty=$host_dirty"
fi

# 2. Daily audit passed within 24 h (observable effect: the audit's own result in the journal).
last_audit=$(journalctl --user -u claude-mem-local-maintenance.service --since '-24h' --no-pager -o cat 2>/dev/null | grep -c 'checks passed')
if [ "$last_audit" -ge 1 ]; then pass audit-24h "$last_audit passing run(s) in journal"; else fail audit-24h "no 'checks passed' line in the last 24h"; fi

# 3. Candidate worktree at the expected commit and clean.
cand_head=$(git -C "$CANDIDATE" rev-parse HEAD 2>/dev/null)
cand_dirty=$(git -C "$CANDIDATE" status --porcelain 2>/dev/null | wc -l)
if [ "$cand_head" = "$(git -C "$CANDIDATE" rev-parse "$COMMIT" 2>/dev/null)" ] && [ "$cand_dirty" -eq 0 ]; then
  pass candidate-commit "${cand_head:0:9}, clean"
else
  fail candidate-commit "HEAD ${cand_head:0:9} expected ${COMMIT:0:9} dirty=$cand_dirty"
fi

# 4. Candidate version pinned as expected.
cand_version=$(json "$CANDIDATE/package.json" "d['version']")
if [ -n "$EXPECT_VERSION" ]; then
  if [ "$cand_version" = "$EXPECT_VERSION" ]; then pass candidate-version "$cand_version"; else fail candidate-version "package.json $cand_version expected $EXPECT_VERSION"; fi
  mism=$(for f in "$CANDIDATE"/.claude-plugin/plugin.json "$CANDIDATE"/.codex-plugin/plugin.json "$CANDIDATE"/.grok-plugin/plugin.json "$CANDIDATE"/openclaw/openclaw.plugin.json "$CANDIDATE"/plugin/.claude-plugin/plugin.json "$CANDIDATE"/plugin/.codex-plugin/plugin.json "$CANDIDATE"/plugin/package.json "$CANDIDATE"/claude-mem-cursor/.cursor-plugin/plugin.json "$CANDIDATE"/claude-mem-grok-bot/.cursor-plugin/plugin.json; do [ -f "$f" ] || continue; v=$(json "$f" "d['version']"); [ "$v" = "$EXPECT_VERSION" ] || echo "${f#$CANDIDATE/}=$v"; done; v=$(json "$CANDIDATE/.claude-plugin/marketplace.json" "d['plugins'][0]['version']"); [ "$v" = "$EXPECT_VERSION" ] || echo ".claude-plugin/marketplace.json=$v")
  if [ -z "$mism" ]; then pass manifests-version "all manifests $EXPECT_VERSION"; else fail manifests-version "$mism"; fi
fi

# 5. Committed bundles match the recorded hashes (the build is deterministic; a mismatch means src changed after the hashes were recorded).
if [ -n "$WORKER_SHA" ]; then
  got=$(sha256sum "$CANDIDATE/plugin/scripts/worker-service.cjs" | cut -d' ' -f1)
  [ "$got" = "$WORKER_SHA" ] && pass worker-bundle-sha "${got:0:16}" || fail worker-bundle-sha "${got:0:16} expected ${WORKER_SHA:0:16}"
fi
if [ -n "$CTX_SHA" ]; then
  got=$(sha256sum "$CANDIDATE/plugin/scripts/context-generator.cjs" | cut -d' ' -f1)
  [ "$got" = "$CTX_SHA" ] && pass context-bundle-sha "${got:0:16}" || fail context-bundle-sha "${got:0:16} expected ${CTX_SHA:0:16}"
fi

# 6. Live worker: healthy, version and PID match the receipt.
live_version=$(http_json "$WORKER_URL/api/health" "d.get('version')")
live_status=$(http_json "$WORKER_URL/api/health" "d.get('status')")
live_pid=$(http_json "$WORKER_URL/api/health" "d.get('pid') or d.get('workerPid')")
receipt_version=$(json "$RECEIPT" "d['version']"); receipt_pid=$(json "$RECEIPT" "d.get('workerPid')")
if [ "$live_status" = ok ] && [ "$live_version" = "$receipt_version" ] && [ "$live_pid" = "$receipt_pid" ]; then
  pass live-worker "ok $live_version pid $live_pid"
else
  fail live-worker "status=$live_status version=$live_version pid=$live_pid receipt=$receipt_version/$receipt_pid"
fi

# 7. Queue drained (RAM queue; a SQLite backup does not preserve it).
depth=$(http_json "$WORKER_URL/api/processing-status" "d.get('queueDepth')")
if [ "$depth" = 0 ]; then pass queue-drained "queueDepth 0"
elif [ "$ALLOW_QUEUE" -eq 1 ]; then pass queue-drained "queueDepth $depth (owner accepted transcript archive path)"
else fail queue-drained "queueDepth ${depth:-unknown}; wait, or pass --allow-queue after deciding to archive transcripts"; fi

# 8. Settings: claude-mem settings parse and carry the threshold; Claude's settings keep autoUpdate false (the audit asserts the same key).
if python3 -c "import json;json.load(open('$SETTINGS'))" 2>/dev/null; then
  au=$(json "$CLAUDE_SETTINGS" "d.get('extraKnownMarketplaces',{}).get('thedotmack',{}).get('autoUpdate')")
  thr=$(json "$SETTINGS" "d.get('$THRESHOLD_KEY', d.get('env',{}).get('$THRESHOLD_KEY'))")
  [ "$au" = False ] && pass settings-autoupdate "thedotmack.autoUpdate false in $CLAUDE_SETTINGS" || fail settings-autoupdate "autoUpdate=$au in $CLAUDE_SETTINGS"
  [ "$thr" = "$THRESHOLD_VALUE" ] && pass settings-threshold "$THRESHOLD_KEY=$thr" || fail settings-threshold "$THRESHOLD_KEY=${thr:-absent}; upstream default 0.93 applies until set to $THRESHOLD_VALUE"
else
  fail settings-parse "$SETTINGS does not parse"
fi

# 9. Backup directory writable with headroom for the SQLite snapshot and the three roots.
db_bytes=$(stat -c %s "$HOME/.claude-mem/claude-mem.sqlite3" 2>/dev/null || echo 0)
roots_bytes=$(json "$RECEIPT" "0" ); roots_bytes=0
for r in $(json "$RECEIPT" "' '.join(d['installationRoots'].values())"); do roots_bytes=$((roots_bytes + $(du -sb "$r" 2>/dev/null | cut -f1 || echo 0))); done
need=$(( (db_bytes + roots_bytes) * 2 / 1024 ))
avail=$(df -k --output=avail "$BACKUPS" 2>/dev/null | tail -1 | tr -d ' ')
if [ -d "$BACKUPS" ] && [ -w "$BACKUPS" ] && [ -n "$avail" ] && [ "$avail" -gt "$need" ]; then
  pass backup-headroom "need ~$((need/1024)) MiB, avail $((avail/1024)) MiB"
else
  fail backup-headroom "dir=$BACKUPS writable=$([ -w "$BACKUPS" ] && echo yes || echo no) need ${need}K avail ${avail:-?}K"
fi

echo
if [ "$fails" -eq 0 ]; then echo "preflight: all checks passed"; exit 0; else echo "preflight: $fails check(s) failed"; exit 1; fi
