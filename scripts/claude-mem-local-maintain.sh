#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
if [[ "$mode" != "--check" && "$mode" != "--apply" ]]; then
  echo "usage: claude-mem-local-maintain [--check|--apply]" >&2
  exit 2
fi

fork_root="${CLAUDE_MEM_FORK_ROOT:-/home/sk/development/tools/claude-mem}"
local_branch="${CLAUDE_MEM_LOCAL_BRANCH:-local/observation-grounding}"
upstream_ref="${CLAUDE_MEM_UPSTREAM_REF:-upstream/main}"
state_dir="${CLAUDE_MEM_STATE_DIR:-/home/sk/.local/state/claude-mem-maintenance}"
verify_hook="${CLAUDE_MEM_VERIFY_HOOK:-}"
deploy_hook="${CLAUDE_MEM_DEPLOY_HOOK:-}"
worker_status_hook="${CLAUDE_MEM_WORKER_STATUS_HOOK:-}"
cachebuster_helper="${CLAUDE_MEM_CACHEBUSTER_HELPER:-/home/sk/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py}"
installed_worker_bundle="${CLAUDE_MEM_INSTALLED_WORKER_BUNDLE:-}"
data_dir="${CLAUDE_MEM_DATA_DIR:-/home/sk/.claude-mem}"

mkdir -p "$state_dir"
exec 9>"$state_dir/maintenance.lock"
if ! flock -n 9; then
  echo "claude-mem maintenance already running"
  exit 0
fi

failure_file="$state_dir/last-failure"
candidate_parent=""
candidate=""

record_failure() {
  local stage="$1"
  local message="$2"
  local temp_file="$state_dir/.last-failure.$$"
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$stage" "$message" > "$temp_file"
  mv "$temp_file" "$failure_file"
}

cleanup() {
  if [[ -n "$candidate" ]] && git -C "$fork_root" worktree list --porcelain | grep -Fqx "worktree $candidate"; then
    git -C "$fork_root" worktree remove --force "$candidate" >/dev/null 2>&1 || true
  fi
  if [[ -n "$candidate_parent" && -d "$candidate_parent" ]]; then
    rmdir "$candidate_parent" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_real_verification() {
  local source_root="$1"
  (
    cd "$source_root"
    bun install --frozen-lockfile
    bun test \
      tests/sdk/prompts.test.ts \
      tests/sdk/parser.test.ts \
      tests/sdk/output-classifier.test.ts \
      tests/gemini_provider.test.ts \
      tests/worker/openai-compatible-summary-tier.test.ts \
      tests/worker/agents/response-processor.test.ts
    bunx tsc --noEmit
    npm run build
    git diff --check
  )
}

commit_generated_artifacts() {
  local source_root="$1"
  local dirty_paths
  dirty_paths="$(
    {
      git -C "$source_root" diff --name-only
      git -C "$source_root" ls-files --others --exclude-standard
    } | sort -u
  )"
  [[ -n "$dirty_paths" ]] || return 0

  local invalid_paths
  invalid_paths="$(printf '%s\n' "$dirty_paths" | grep -Ev '^(plugin/|dist/|openclaw/dist/)' || true)"
  if [[ -n "$invalid_paths" ]]; then
    record_failure "verify" "verification modified non-generated paths: $(printf '%s' "$invalid_paths" | tr '\n' ' ')"
    return 1
  fi

  git -C "$source_root" add plugin dist openclaw/dist
  if ! git -C "$source_root" diff --cached --quiet; then
    git -C "$source_root" commit -m "chore(local): rebuild plugin after upstream update"
  fi
}

read_worker_status() {
  if [[ -n "$worker_status_hook" ]]; then
    "$worker_status_hook"
    return
  fi
  local log_file=""
  local newest_mtime=-1
  local candidate_log
  local candidate_mtime
  shopt -s nullglob
  for candidate_log in "$data_dir"/logs/claude-mem-*.log; do
    candidate_mtime="$(stat -c %Y "$candidate_log")"
    if (( candidate_mtime > newest_mtime )); then
      newest_mtime="$candidate_mtime"
      log_file="$candidate_log"
    fi
  done
  shopt -u nullglob
  [[ -n "$log_file" ]] || return 1
  grep -E '^\[[0-9-]+ [0-9:.]+\] \[INFO \] \[WORKER\] Broadcasting processing status' "$log_file" | tail -n 1
}

run_real_deploy() {
  local source_root="$1"
  local worker_bundle="$installed_worker_bundle"
  if [[ -z "$worker_bundle" ]]; then
    local version
    version="$(jq -r .version "$source_root/package.json")"
    worker_bundle="/home/sk/.claude/plugins/cache/thedotmack/claude-mem/$version/scripts/worker-service.cjs"
  fi
  (
    cd "$source_root"
    python3 "$cachebuster_helper" plugin
    npm run sync-marketplace
    codex plugin add claude-mem@claude-mem-local --json
    npm run worker:restart
  )

  local health
  health="$(curl -fsS --max-time 10 http://127.0.0.1:37777/health)"
  [[ "$(jq -r '.status // ""' <<< "$health")" == "ok" ]]
  grep -Fq 'USER REQUESTS ARE INTENT, NOT EVIDENCE' "$worker_bundle"
  grep -Fq '<skip_observation />' "$worker_bundle"
  [[ "$(jq -r '.consecutiveFailures // 0' "$data_dir/observer-health.json")" == "0" ]]
}

if [[ ! -d "$fork_root/.git" ]]; then
  record_failure "preflight" "fork root is not a Git repository: $fork_root"
  exit 3
fi

if [[ -n "$(git -C "$fork_root" status --porcelain)" ]]; then
  record_failure "preflight" "durable clone is dirty"
  exit 4
fi

if git -C "$fork_root" worktree list --porcelain | grep -Fqx "branch refs/heads/$local_branch"; then
  record_failure "preflight" "local branch is checked out in a worktree"
  exit 5
fi

git -C "$fork_root" fetch upstream --tags --prune
git -C "$fork_root" fetch origin --prune

old_head="$(git -C "$fork_root" rev-parse "refs/heads/$local_branch")"
old_remote_head="$(git -C "$fork_root" rev-parse "refs/remotes/origin/$local_branch")"
upstream_head="$(git -C "$fork_root" rev-parse "$upstream_ref")"

deployed_head=""
if [[ -f "$state_dir/deployed-commit" ]]; then
  deployed_head="$(tr -d '[:space:]' < "$state_dir/deployed-commit")"
fi
if git -C "$fork_root" merge-base --is-ancestor "$upstream_head" "$old_head" \
  && [[ "$old_remote_head" == "$old_head" ]] \
  && [[ "$deployed_head" == "$old_head" ]]; then
  rm -f "$failure_file"
  echo "claude-mem local maintenance is already current at $old_head"
  exit 0
fi

candidate_parent="$(mktemp -d "${TMPDIR:-/tmp}/claude-mem-maintain-candidate.XXXXXX")"
candidate="$candidate_parent/worktree"
git -C "$fork_root" worktree add --detach "$candidate" "$old_head" >/dev/null

if ! git -C "$candidate" rebase "$upstream_head"; then
  git -C "$candidate" rebase --abort >/dev/null 2>&1 || true
  record_failure "rebase" "candidate conflicts with $upstream_ref"
  exit 10
fi

if [[ -n "$verify_hook" ]]; then
  if ! "$verify_hook" "$candidate"; then
    record_failure "verify" "verification hook failed"
    exit 11
  fi
else
  if ! run_real_verification "$candidate"; then
    record_failure "verify" "production verification failed"
    exit 12
  fi
fi

if ! commit_generated_artifacts "$candidate"; then
  exit 15
fi

candidate_head="$(git -C "$candidate" rev-parse HEAD)"

if [[ "$mode" == "--check" ]]; then
  echo "candidate verified: $candidate_head"
  rm -f "$failure_file"
  exit 0
fi

git -C "$fork_root" update-ref "refs/heads/$local_branch" "$candidate_head" "$old_head"
git -C "$fork_root" push \
  "--force-with-lease=refs/heads/$local_branch:$old_remote_head" \
  origin "$candidate_head:refs/heads/$local_branch"

status_output="$(read_worker_status || true)"
if [[ "$status_output" != *"queueDepth=0"* ]]; then
  record_failure "deploy-deferred" "worker queue is not idle"
  exit 20
fi

if [[ -n "$deploy_hook" ]]; then
  if ! "$deploy_hook" "$candidate"; then
    record_failure "deploy" "deployment hook failed"
    exit 13
  fi
else
  if ! run_real_deploy "$candidate"; then
    record_failure "deploy" "production deployment failed"
    exit 14
  fi
fi

marker_temp="$state_dir/.deployed-commit.$$"
printf '%s\n' "$candidate_head" > "$marker_temp"
mv "$marker_temp" "$state_dir/deployed-commit"
rm -f "$failure_file"
echo "claude-mem local maintenance deployed $candidate_head"
