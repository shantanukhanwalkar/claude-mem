#!/usr/bin/env bash
# claude-mem-adopt-candidate.sh — adopt a reviewed candidate build into the live
# claude-mem installation (HAR-1103), the runbook's steps 4-6 as one unattended run.
#
#   --check   read-only: tools, preflight, resolved plan. Writes nothing.
#   --apply   the window: archive, move local/stable, install Claude + Codex roots,
#             settings key, API stop of the old worker, start of the new one,
#             verification, host checkout, receipt, audit, PROVIDER-STATE entry.
#             Aborts before any mutation unless the preflight passes (empty RAM
#             queue included); rolls back on any failure after installation.
#
# Options: --candidate DIR (default /home/sk/worktrees/claude-mem-candidate-13.32)
#          --version V (default 13.32.1-local.1)  --queue-wait-min N (default 25)
#          --skip-codex   leave the Codex copy alone (Claude side only)
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v24.13.0/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

MODE=""; CANDIDATE=/home/sk/worktrees/claude-mem-candidate-13.32; VERSION=13.32.1-local.1; QUEUE_WAIT_MIN=25; SKIP_CODEX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;; --apply) MODE=apply ;;
    --candidate) CANDIDATE="$2"; shift ;; --version) VERSION="$2"; shift ;;
    --queue-wait-min) QUEUE_WAIT_MIN="$2"; shift ;; --skip-codex) SKIP_CODEX=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac; shift
done
[ -n "$MODE" ] || { echo "need --check or --apply" >&2; exit 2; }

HOST_SRC=/home/sk/development/tools/claude-mem
STATE_DIR="$HOME/.local/state/claude-mem-maintenance"
RECEIPT="$STATE_DIR/deployment.json"
LOGDIR="$STATE_DIR/adopt-$VERSION"; mkdir -p "$LOGDIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$LOGDIR/$MODE-$TS.log"
ARCHIVE="$STATE_DIR/backups/adopt-$VERSION-$TS"
CACHE_BASE="$HOME/.claude/plugins/cache/thedotmack/claude-mem"
MARKETPLACE="$HOME/.claude/plugins/marketplaces/thedotmack"
INSTALLED_JSON="$HOME/.claude/plugins/installed_plugins.json"
KNOWN_JSON="$HOME/.claude/plugins/known_marketplaces.json"
CODEX_CACHE_BASE="$HOME/.codex/plugins/cache/claude-mem-local/claude-mem"
CODEX_CONFIG="$HOME/.codex/config.toml"
WORKER_URL=http://127.0.0.1:37777
DB="$HOME/.claude-mem/claude-mem.db"
SETTINGS="$HOME/.claude-mem/settings.json"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
PROVIDER_STATE="$HOME/.claude-mem/PROVIDER-STATE.md"
THRESHOLD_KEY=CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY; THRESHOLD_VALUE=0.95
PREFLIGHT="$CANDIDATE/ops/local-maintenance/claude-mem-candidate-preflight.sh"
OLD_TAG="local/stable-13.24.2-local.2"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
step() { log "=== $*"; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2" 2>/dev/null; }
http_json() { curl -s -m 5 "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$2" 2>/dev/null; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
queue_depth() { http_json "$WORKER_URL/api/processing-status" "d.get('queueDepth')"; }
health() { curl -s -m 5 "$WORKER_URL/api/health"; }

# ---- resolved facts -------------------------------------------------------
OLD_VERSION=$(json "$RECEIPT" "d['version']"); OLD_COMMIT=$(json "$RECEIPT" "d['commit']"); OLD_PID=$(json "$RECEIPT" "d.get('workerPid')")
OLD_CLAUDE_ROOT=$(json "$RECEIPT" "d['installationRoots']['claude']"); OLD_CODEX_ROOT=$(json "$RECEIPT" "d['installationRoots']['codex']")
NEW_CLAUDE_ROOT="$CACHE_BASE/$VERSION"
EXPECT_WORKER_SHA=$(sha "$CANDIDATE/plugin/scripts/worker-service.cjs"); EXPECT_CTX_SHA=$(sha "$CANDIDATE/plugin/scripts/context-generator.cjs")
CAND_TIP=$(git -C "$CANDIDATE" rev-parse HEAD)
HOST_HEAD=$(git -C "$HOST_SRC" rev-parse HEAD)
MKT_HEAD=$(git -C "$MARKETPLACE" rev-parse HEAD 2>/dev/null)
PHASE=preflight; MUTATED=0; HOST_MOVED=0; REMOTE_MOVED=0; MKT_MOVED=0; NEW_WORKER_PID=""; OLD_REMOTE_TIP=""

# ---- rollback ---------------------------------------------------------------
rollback() {
  local why="$1"; step "ROLLBACK after phase $PHASE: $why"
  curl -s -m 5 -X POST "$WORKER_URL/api/admin/shutdown" >/dev/null 2>&1 || true; sleep 5
  if [ -d "$NEW_CLAUDE_ROOT" ]; then mkdir -p "$ARCHIVE/failed"; mv "$NEW_CLAUDE_ROOT" "$ARCHIVE/failed/claude-root" && log "hid new Claude root from the version oracle"; fi
  for f in installed_plugins.json known_marketplaces.json; do [ -f "$ARCHIVE/$f" ] && cp -a "$ARCHIVE/$f" "$HOME/.claude/plugins/$f" && log "restored $f"; done
  [ -f "$ARCHIVE/settings.json" ] && cp -a "$ARCHIVE/settings.json" "$SETTINGS" && log "restored claude-mem settings.json"
  [ -f "$ARCHIVE/codex-config.toml" ] && cp -a "$ARCHIVE/codex-config.toml" "$CODEX_CONFIG" && log "restored codex config.toml"
  if [ "$MKT_MOVED" = 1 ] && [ -n "$MKT_HEAD" ]; then git -C "$MARKETPLACE" reset -q --hard "$MKT_HEAD" && (cd "$ARCHIVE/marketplace-dirty" 2>/dev/null && find . -type f | while read -r f; do mkdir -p "$MARKETPLACE/$(dirname "$f")"; cp -a "$f" "$MARKETPLACE/$f"; done) && log "marketplace checkout restored to $MKT_HEAD plus its working files"; fi
  if [ "$REMOTE_MOVED" = 1 ] && [ -n "$OLD_REMOTE_TIP" ]; then git -C "$CANDIDATE" push -q origin "+$OLD_REMOTE_TIP:refs/heads/local/stable" && log "origin/local/stable restored to $OLD_REMOTE_TIP"; fi
  if [ "$HOST_MOVED" = 1 ]; then git -C "$HOST_SRC" reset -q --hard "$HOST_HEAD" && log "host checkout restored to $HOST_HEAD"; fi
  if [ ! -d "$OLD_CLAUDE_ROOT" ] && [ -f "$ARCHIVE/old-claude-root.tgz" ]; then tar -C "$(dirname "$OLD_CLAUDE_ROOT")" -xzf "$ARCHIVE/old-claude-root.tgz" && log "old Claude root restored from archive"; fi
  systemd-run --user --scope --unit="claude-mem-worker-rollback-$TS" --collect bun "$OLD_CLAUDE_ROOT/scripts/worker-service.cjs" start >>"$LOG" 2>&1 || true
  for i in $(seq 1 24); do v=$(http_json "$WORKER_URL/api/health" "d.get('version')"); [ "$v" = "$OLD_VERSION" ] && break; sleep 5; done
  log "old worker health: $(health | cut -c1-200)"
  python3 - "$ARCHIVE/manifest.json" "$why" <<'PY'
import json,sys,datetime
p=sys.argv[1]; d=json.load(open(p)); d['status']='rolled-back'; d['rollbackReason']=sys.argv[2]; d['rolledBackAt']=datetime.datetime.utcnow().isoformat()+'Z'; json.dump(d,open(p,'w'),indent=1)
PY
  log "rolled back; receipt untouched; see $LOG"; exit 1
}
die() { if [ "$MUTATED" = 1 ]; then rollback "$*"; else log "ABORT before any mutation: $*"; exit 1; fi; }

# ---- check mode -------------------------------------------------------------
step "mode=$MODE version=$VERSION candidate=$CANDIDATE tip=${CAND_TIP:0:9} log=$LOG"
for t in bun node claude codex jq git curl python3; do command -v "$t" >/dev/null || die "tool missing on PATH: $t"; done
log "tools: bun=$(command -v bun) node=$(command -v node) claude=$(command -v claude) codex=$(command -v codex)"
[ -x "$PREFLIGHT" ] || die "preflight script missing at $PREFLIGHT"
git -C "$CANDIDATE" fetch -q origin || die "cannot fetch origin from candidate"
[ "$(git -C "$CANDIDATE" rev-parse origin/candidate/v13.32.0)" = "$CAND_TIP" ] || die "candidate worktree tip != origin/candidate/v13.32.0"
[ "$(git -C "$CANDIDATE" status --porcelain | wc -l)" -eq 0 ] || die "candidate worktree dirty"
[ "$(json "$CANDIDATE/package.json" "d['version']")" = "$VERSION" ] || die "candidate package.json version != $VERSION"
OLD_REMOTE_TIP=$(git -C "$CANDIDATE" rev-parse origin/local/stable)
log "old: version=$OLD_VERSION commit=${OLD_COMMIT:0:9} pid=$OLD_PID claudeRoot=$OLD_CLAUDE_ROOT"
log "new: version=$VERSION tip=${CAND_TIP:0:9} workerSha=${EXPECT_WORKER_SHA:0:16} ctxSha=${EXPECT_CTX_SHA:0:16} claudeRoot=$NEW_CLAUDE_ROOT"
log "remote: origin/local/stable=${OLD_REMOTE_TIP:0:9} -> ${CAND_TIP:0:9}; tag $OLD_TAG; marketplace HEAD ${MKT_HEAD:0:9} ($(git -C "$MARKETPLACE" status --porcelain | wc -l) dirty files)"
[ -d "$NEW_CLAUDE_ROOT" ] && die "new Claude root already exists: $NEW_CLAUDE_ROOT (a previous run?)"
git -C "$CANDIDATE" push --dry-run origin "+$CAND_TIP:refs/heads/local/stable" >>"$LOG" 2>&1 || die "git push dry-run to origin failed"
# VACUUM INTO works here? (tiny private db)
tmpd=$(mktemp -d); bun -e "const {Database}=require('bun:sqlite'); const d=new Database('$tmpd/a.db'); d.exec('create table t(x)'); d.exec(\"vacuum into '$tmpd/b.db'\"); const c=new Database('$tmpd/b.db',{readonly:true}); console.log(c.query('pragma quick_check').get());" >>"$LOG" 2>&1 || die "bun:sqlite VACUUM INTO probe failed"; rm -rf "$tmpd"
if [ "$MODE" = check ]; then
  step "preflight (informational in --check)"; "$PREFLIGHT" --check --candidate "$CANDIDATE" --commit "$CAND_TIP" --expect-version "$VERSION" --worker-sha "$EXPECT_WORKER_SHA" --ctx-sha "$EXPECT_CTX_SHA" 2>&1 | tee -a "$LOG"
  step "plan: archive -> tag+move local/stable -> reset marketplace -> claude plugin update (fallback copy) -> codex remove/add -> settings key -> API shutdown old -> start new -> verify -> host checkout -> receipt -> audit -> PROVIDER-STATE"
  log "check complete; nothing written except $LOG"; exit 0
fi

# ---- apply ------------------------------------------------------------------
step "P0 wait for an empty RAM queue (up to $QUEUE_WAIT_MIN min)"
deadline=$(( $(date +%s) + QUEUE_WAIT_MIN*60 ))
while :; do q=$(queue_depth); log "queueDepth=${q:-unknown}"; [ "$q" = 0 ] && break; [ $(date +%s) -ge $deadline ] && die "queue never drained (last ${q:-unknown})"; sleep 30; done
step "P0 preflight"
"$PREFLIGHT" --check --candidate "$CANDIDATE" --commit "$CAND_TIP" --expect-version "$VERSION" --worker-sha "$EXPECT_WORKER_SHA" --ctx-sha "$EXPECT_CTX_SHA" > "$LOGDIR/preflight-$TS.txt" 2>&1
cat "$LOGDIR/preflight-$TS.txt" | tee -a "$LOG" >/dev/null
# the only acceptable FAIL before install is the threshold key, which P6 writes
other=$(grep '^FAIL' "$LOGDIR/preflight-$TS.txt" | grep -v -c settings-threshold)
[ "$other" -eq 0 ] || die "preflight failed on something other than the threshold key: $(grep '^FAIL' "$LOGDIR/preflight-$TS.txt" | grep -v settings-threshold | awk '{print $2}' | tr '\n' ' ')"

step "P1 archive -> $ARCHIVE"
PHASE=archive; mkdir -p "$ARCHIVE/marketplace-dirty" "$ARCHIVE/old-roots"
bun -e "const {Database}=require('bun:sqlite'); const d=new Database('$DB',{readonly:true}); d.exec(\"vacuum into '$ARCHIVE/claude-mem.db'\"); const c=new Database('$ARCHIVE/claude-mem.db',{readonly:true}); const r=c.query('pragma quick_check').get(); console.log(JSON.stringify(r)); if(JSON.stringify(r).indexOf('ok')<0) process.exit(3);" >>"$LOG" 2>&1 || die "SQLite snapshot failed"
log "sqlite snapshot $(stat -c %s "$ARCHIVE/claude-mem.db") bytes, quick_check ok"
cp -a "$RECEIPT" "$ARCHIVE/deployment.json"; cp -a "$SETTINGS" "$ARCHIVE/settings.json"; cp -a "$CLAUDE_SETTINGS" "$ARCHIVE/claude-settings.json"
cp -a "$INSTALLED_JSON" "$ARCHIVE/installed_plugins.json"; cp -a "$KNOWN_JSON" "$ARCHIVE/known_marketplaces.json"; cp -a "$CODEX_CONFIG" "$ARCHIVE/codex-config.toml"
for f in quota-cooldown.json observer-health.json worker.pid; do [ -f "$HOME/.claude-mem/$f" ] && cp -a "$HOME/.claude-mem/$f" "$ARCHIVE/"; done
git -C "$MARKETPLACE" status --porcelain | awk '{print $2}' | while read -r f; do [ -f "$MARKETPLACE/$f" ] && mkdir -p "$ARCHIVE/marketplace-dirty/$(dirname "$f")" && cp -a "$MARKETPLACE/$f" "$ARCHIVE/marketplace-dirty/$f"; done
for kind in claude codex marketplace; do r=$(json "$RECEIPT" "d['installationRoots']['$kind']"); mkdir -p "$ARCHIVE/old-roots/$kind"; cp -a "$r/package.json" "$r/scripts" "$ARCHIVE/old-roots/$kind/" 2>/dev/null; cp -a "$r/.claude-plugin" "$r/.codex-plugin" "$ARCHIVE/old-roots/$kind/" 2>/dev/null; done
tar -C "$(dirname "$OLD_CLAUDE_ROOT")" -czf "$ARCHIVE/old-claude-root.tgz" "$(basename "$OLD_CLAUDE_ROOT")" || die "old Claude root tar failed"
(cd "$ARCHIVE" && find . -type f ! -name sha256.txt -exec sha256sum {} + > sha256.txt)
python3 - "$ARCHIVE/manifest.json" "$CAND_TIP" "$OLD_REMOTE_TIP" "$MKT_HEAD" "$OLD_PID" "$VERSION" "$OLD_VERSION" "$EXPECT_WORKER_SHA" <<'PY'
import json,sys,datetime
a=sys.argv; json.dump({'createdAt':datetime.datetime.utcnow().isoformat()+'Z','status':'prepared-not-activated','candidateCommit':a[2],'oldRemoteLocalStable':a[3],'oldMarketplaceHead':a[4],'oldWorkerPid':a[5],'newVersion':a[6],'oldVersion':a[7],'expectedWorkerSha256':a[8],'queueDepthAtBoundary':0},open(a[1],'w'),indent=1)
PY
log "archive written ($(wc -l < "$ARCHIVE/sha256.txt") files)"

step "P2 tag old local/stable and move it to the candidate"
PHASE=remote; MUTATED=1
if ! git -C "$CANDIDATE" rev-parse -q --verify "refs/tags/$OLD_TAG" >/dev/null; then git -C "$CANDIDATE" tag "$OLD_TAG" "$OLD_REMOTE_TIP" || die "tag failed"; fi
git -C "$CANDIDATE" push -q origin "refs/tags/$OLD_TAG" >>"$LOG" 2>&1 || die "tag push failed"
git -C "$CANDIDATE" push -q origin "+$CAND_TIP:refs/heads/local/stable" >>"$LOG" 2>&1 || die "local/stable push failed"; REMOTE_MOVED=1
git -C "$CANDIDATE" fetch -q origin; [ "$(git -C "$CANDIDATE" rev-parse origin/local/stable)" = "$CAND_TIP" ] || die "origin/local/stable did not land on the candidate"
log "origin/local/stable=${CAND_TIP:0:9}; old tip kept as tag $OLD_TAG"

step "P3 marketplace checkout -> candidate"
PHASE=marketplace; MKT_MOVED=1
git -C "$MARKETPLACE" fetch -q origin >>"$LOG" 2>&1 || die "marketplace fetch failed"
git -C "$MARKETPLACE" reset -q --hard "$CAND_TIP" >>"$LOG" 2>&1 || die "marketplace reset failed"
git -C "$MARKETPLACE" clean -fdq >>"$LOG" 2>&1
[ "$(sha "$MARKETPLACE/plugin/scripts/worker-service.cjs")" = "$EXPECT_WORKER_SHA" ] || die "marketplace worker bundle hash mismatch"
[ "$(json "$MARKETPLACE/plugin/package.json" "d['version']")" = "$VERSION" ] || die "marketplace plugin version mismatch"
log "marketplace at ${CAND_TIP:0:9}, bundle hash ok"

step "P4 Claude cache root"
PHASE=claude-root
timeout 240 claude plugin update claude-mem@thedotmack -s user -y --json >>"$LOG" 2>&1; log "claude plugin update rc=$?"
inst_ver=$(json "$INSTALLED_JSON" "d['plugins']['claude-mem@thedotmack'][0]['version']"); inst_path=$(json "$INSTALLED_JSON" "d['plugins']['claude-mem@thedotmack'][0]['installPath']")
if [ "$inst_ver" != "$VERSION" ] || [ ! -d "$inst_path" ]; then
  log "official update did not produce $VERSION (got '$inst_ver' at '$inst_path'); installing by copy + registry edit"
  mkdir -p "$NEW_CLAUDE_ROOT" && cp -a "$CANDIDATE/plugin/." "$NEW_CLAUDE_ROOT/" || die "copy to new Claude root failed"
  python3 - "$INSTALLED_JSON" "$NEW_CLAUDE_ROOT" "$VERSION" "$CAND_TIP" <<'PY' || die "installed_plugins.json edit failed"
import json,sys,datetime
p,root,ver,sha=sys.argv[1:5]; d=json.load(open(p)); e=d['plugins']['claude-mem@thedotmack'][0]
e.update({'installPath':root,'version':ver,'lastUpdated':datetime.datetime.utcnow().isoformat(timespec='milliseconds')+'Z','gitCommitSha':sha})
json.dump(d,open(p,'w'),indent=2)
PY
else
  NEW_CLAUDE_ROOT="$inst_path"; log "official update installed $inst_ver at $inst_path"
fi
if [ ! -d "$NEW_CLAUDE_ROOT/node_modules" ] || [ "$(ls "$NEW_CLAUDE_ROOT/node_modules" | wc -l)" -lt 26 ]; then cp -a "$CANDIDATE/plugin/node_modules" "$NEW_CLAUDE_ROOT/" || die "node_modules copy failed"; log "node_modules copied from candidate"; fi
[ "$(sha "$NEW_CLAUDE_ROOT/scripts/worker-service.cjs")" = "$EXPECT_WORKER_SHA" ] || die "new Claude root worker hash mismatch"
[ "$(json "$NEW_CLAUDE_ROOT/package.json" "d['version']")" = "$VERSION" ] || die "new Claude root package version mismatch"
[ "$(json "$NEW_CLAUDE_ROOT/.claude-plugin/plugin.json" "d['version']")" = "$VERSION" ] || die "new Claude root manifest version mismatch"
missing=$(python3 -c "import json,os,sys; r=sys.argv[1]; d=json.load(open(r+'/package.json'))['dependencies']; print(' '.join(k for k in d if not os.path.exists(r+'/node_modules/'+k)))" "$NEW_CLAUDE_ROOT"); [ -z "$missing" ] || die "new Claude root missing deps: $missing"
[ "$(json "$KNOWN_JSON" "d['thedotmack']['autoUpdate']")" = False ] || die "known_marketplaces autoUpdate is no longer false"
log "Claude root ready: $NEW_CLAUDE_ROOT (deps complete, hashes ok)"

step "P5 Codex copy"
PHASE=codex; NEW_CODEX_ROOT=""
if [ "$SKIP_CODEX" = 1 ]; then log "skipped by flag"; else
  timeout 120 codex plugin remove claude-mem@claude-mem-local >>"$LOG" 2>&1; log "codex remove rc=$?"
  timeout 240 codex plugin add claude-mem@claude-mem-local >>"$LOG" 2>&1; log "codex add rc=$?"
  NEW_CODEX_ROOT=$(ls -d "$CODEX_CACHE_BASE/$VERSION"* 2>/dev/null | head -1)
  if [ -n "$NEW_CODEX_ROOT" ] && [ "$(sha "$NEW_CODEX_ROOT/scripts/worker-service.cjs" 2>/dev/null)" = "$EXPECT_WORKER_SHA" ]; then
    [ -d "$NEW_CODEX_ROOT/node_modules" ] || cp -a "$CANDIDATE/plugin/node_modules" "$NEW_CODEX_ROOT/"
    grep -q 'plugins."claude-mem@claude-mem-local"' "$CODEX_CONFIG" || printf '\n[plugins."claude-mem@claude-mem-local"]\nenabled = true\n' >> "$CODEX_CONFIG"
    log "Codex root ready: $NEW_CODEX_ROOT"
  else
    log "WARN Codex reinstall did not produce a verified root (found '${NEW_CODEX_ROOT:-none}'); Claude side continues, Codex needs a manual 'codex plugin add claude-mem@claude-mem-local'"
    NEW_CODEX_ROOT=""
  fi
fi

step "P6 settings: $THRESHOLD_KEY=$THRESHOLD_VALUE"
PHASE=settings
jq --arg k "$THRESHOLD_KEY" --arg v "$THRESHOLD_VALUE" '.[$k]=$v' "$SETTINGS" > "$SETTINGS.tmp.$$" && python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SETTINGS.tmp.$$" && chmod 600 "$SETTINGS.tmp.$$" && mv "$SETTINGS.tmp.$$" "$SETTINGS" || die "settings write failed"
[ "$(json "$SETTINGS" "d.get('$THRESHOLD_KEY')")" = "$THRESHOLD_VALUE" ] || die "settings read-back failed"
[ "$(json "$SETTINGS" "d.get('CLAUDE_MEM_PROVIDER')")" = "$(json "$ARCHIVE/settings.json" "d.get('CLAUDE_MEM_PROVIDER')")" ] || die "provider changed unexpectedly"
log "settings ok; provider unchanged ($(json "$SETTINGS" "d.get('CLAUDE_MEM_PROVIDER')"))"

step "P7 restart: API shutdown of PID $OLD_PID, then start from the new root"
PHASE=restart
q=$(queue_depth); [ "$q" = 0 ] || { for i in $(seq 1 10); do sleep 30; q=$(queue_depth); [ "$q" = 0 ] && break; done; }
[ "$q" = 0 ] || die "queue refilled to $q before the restart"
boundary=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -m 10 -X POST "$WORKER_URL/api/admin/shutdown" >>"$LOG" 2>&1; log "shutdown requested at $boundary rc=$?"
for i in $(seq 1 30); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 3; done
if kill -0 "$OLD_PID" 2>/dev/null; then log "old worker still alive after 90s, CLI stop"; bun "$OLD_CLAUDE_ROOT/scripts/worker-service.cjs" stop >>"$LOG" 2>&1; sleep 5; fi
kill -0 "$OLD_PID" 2>/dev/null && die "old worker PID $OLD_PID would not exit"
for i in $(seq 1 20); do curl -s -m 2 "$WORKER_URL/api/health" >/dev/null 2>&1 || break; sleep 2; done
log "old worker gone; starting new"
# A transient scope: the daemon outlives this script whatever launched it (a
# transient service would kill its cgroup on exit), and later API restarts
# spawn successors inside the same scope.
systemd-run --user --scope --unit="claude-mem-worker-$TS" --collect bun "$NEW_CLAUDE_ROOT/scripts/worker-service.cjs" start >>"$LOG" 2>&1; log "start rc=$? (scope claude-mem-worker-$TS)"
for i in $(seq 1 40); do v=$(http_json "$WORKER_URL/api/health" "d.get('version')"); [ "$v" = "$VERSION" ] && break; sleep 3; done
H=$(health); NEW_WORKER_PID=$(echo "$H" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('pid') or d.get('workerPid') or '')" 2>/dev/null)
log "health: $(echo "$H" | cut -c1-300)"
[ "$v" = "$VERSION" ] || die "new worker did not report $VERSION (got '${v:-none}')"
[ -n "$NEW_WORKER_PID" ] && [ "$NEW_WORKER_PID" != "$OLD_PID" ] || die "new worker PID not distinct ('$NEW_WORKER_PID')"
pidfile_pid=$(json "$HOME/.claude-mem/worker.pid" "d.get('pid')"); [ "$pidfile_pid" = "$NEW_WORKER_PID" ] || log "WARN worker.pid says $pidfile_pid, health says $NEW_WORKER_PID"
newcmd=$(tr '\0' ' ' < /proc/$NEW_WORKER_PID/cmdline 2>/dev/null); case "$newcmd" in *"$NEW_CLAUDE_ROOT"*) log "new worker runs from the new root" ;; *) die "new worker cmdline does not reference the new root: $newcmd" ;; esac
for i in $(seq 1 20); do ready=$(http_json "$WORKER_URL/api/health" "d.get('initialized', d.get('ready', d.get('status')=='ok'))"); [ "$ready" = True ] && break; sleep 3; done
log "initialized=$ready"

step "P8 host checkout -> new local/stable"
PHASE=host
[ "$(git -C "$HOST_SRC" status --porcelain | wc -l)" -eq 0 ] || die "host checkout dirty"
git -C "$HOST_SRC" fetch -q origin >>"$LOG" 2>&1 || die "host fetch failed"
git -C "$HOST_SRC" reset -q --hard "$CAND_TIP" >>"$LOG" 2>&1 || die "host reset failed"; HOST_MOVED=1
[ "$(git -C "$HOST_SRC" rev-parse HEAD)" = "$CAND_TIP" ] || die "host HEAD mismatch"
[ "$(sha "$HOST_SRC/plugin/scripts/worker-service.cjs")" = "$EXPECT_WORKER_SHA" ] || die "host source bundle hash mismatch"
log "host checkout at ${CAND_TIP:0:9}"

step "P9 receipt"
PHASE=receipt
python3 - "$RECEIPT" "$ARCHIVE/deployment.json" "$VERSION" "$CAND_TIP" "$EXPECT_WORKER_SHA" "$EXPECT_CTX_SHA" "$NEW_CLAUDE_ROOT" "${NEW_CODEX_ROOT:-$OLD_CODEX_ROOT}" "$MARKETPLACE/plugin" "$KNOWN_JSON" "$HOST_SRC" "$NEW_WORKER_PID" "$OLD_PID" "$ARCHIVE" "$boundary" "$H" <<'PY' || die "receipt write failed"
import json,sys,datetime
(p,oldp,ver,commit,wsha,csha,croot,xroot,mroot,known,src,pid,oldpid,archive,boundary,health)=sys.argv[1:17]
old=json.load(open(oldp)); now=datetime.datetime.utcnow().isoformat()+'Z'
hist=list(old.get('workerPidHistory') or []); hist.append({'pid':int(oldpid),'startedAt':old.get('workerPidObservedAt'),'endedBy':f'API shutdown {boundary} for 13.32.1-local.1 adoption (HAR-1103)'})
rec={'schemaVersion':1,'version':ver,'commit':commit,'workerSha256':wsha,'installationRoots':{'claude':croot,'codex':xroot,'marketplace':mroot},'knownMarketplacesPath':known,'sourceRoot':src,'contextGeneratorSha256':csha,'activatedAt':now,'weeklyPauseThreshold':0.95,'weeklyPauseThresholdSource':'settings.json CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY','workerPid':int(pid),'previousWorkerPid':int(oldpid),'workerPidObservedAt':now,'workerPidHistory':hist,'rollbackArchive':archive,'previousReceipt':oldp,'settingsPreserved':True,'cooldownPreserved':True,'recovery':{'status':'queue-drained-at-boundary','queueDepthAtShutdown':0,'boundary':boundary},'verification':{'at':now,'health':json.loads(health) if health.strip().startswith('{') else health[:300],'captureVerified':False,'note':'capture/retrieval verified by the follow-up session, see HAR-1103'},'upstreamBase':'v13.32.0','carriedUpstreamPRs':[4554,4555,4556,4557]}
if not xroot: rec['installationRoots']['codex']=old['installationRoots']['codex']
json.dump(rec,open(p+'.tmp','w'),indent=1); import os; os.replace(p+'.tmp',p); print('receipt written')
PY
[ -n "$NEW_CODEX_ROOT" ] || log "WARN receipt codex root still points at the old Codex copy; audit will flag its version"

step "P10 audit"
PHASE=audit
node "$HOST_SRC/scripts/audit-local-install.cjs" >>"$LOG" 2>&1; arc=$?; tail -3 "$LOG" | sed 's/^/  /'
if [ "$arc" -ne 0 ]; then
  if [ -z "$NEW_CODEX_ROOT" ] && [ "$SKIP_CODEX" = 0 ]; then log "audit failed; Codex root is the known gap, not rolling back the Claude side"; else die "audit failed"; fi
fi

step "P11 PROVIDER-STATE entry + manifest"
PHASE=paperwork
python3 - "$ARCHIVE/manifest.json" "$NEW_WORKER_PID" "$NEW_CLAUDE_ROOT" "${NEW_CODEX_ROOT:-}" "$arc" <<'PY'
import json,sys,datetime
p=sys.argv[1]; d=json.load(open(p)); d.update({'status':'activated','activatedAt':datetime.datetime.utcnow().isoformat()+'Z','newWorkerPid':sys.argv[2],'newClaudeRoot':sys.argv[3],'newCodexRoot':sys.argv[4] or None,'auditExit':int(sys.argv[5])}); json.dump(d,open(p,'w'),indent=1)
PY
{ printf '## %s — 13.32.1-local.1 activated (HAR-1103, unattended window)\n\n' "$(TZ=Asia/Kolkata date +'%Y-%m-%d %H:%M IST')"
  printf 'Worker API shutdown of PID %s at %s with queueDepth 0; new worker PID %s started from `%s`, health version %s. origin/local/stable moved from %s to %s (old tip tagged `%s`); marketplace checkout and host checkout reset to the same commit; receipt rewritten; audit exit %s. Settings: `%s=%s` added, provider unchanged. Archive: `%s` (SQLite VACUUM INTO snapshot quick_check ok, registries, settings, marketplace working files, old root manifests). Codex root: %s. Capture/retrieval verification follows in the next session and is recorded on HAR-1103.\n\n---\n\n' \
    "$OLD_PID" "$boundary" "$NEW_WORKER_PID" "$NEW_CLAUDE_ROOT" "$VERSION" "${OLD_REMOTE_TIP:0:9}" "${CAND_TIP:0:9}" "$OLD_TAG" "$arc" "$THRESHOLD_KEY" "$THRESHOLD_VALUE" "$ARCHIVE" "${NEW_CODEX_ROOT:-NOT reinstalled, manual codex plugin add needed}"
  cat "$PROVIDER_STATE"; } > "$PROVIDER_STATE.tmp.$$" && mv "$PROVIDER_STATE.tmp.$$" "$PROVIDER_STATE"
step "DONE version=$VERSION pid=$NEW_WORKER_PID audit=$arc archive=$ARCHIVE log=$LOG"
exit "$arc"
