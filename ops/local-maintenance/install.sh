#!/usr/bin/env bash
set -euo pipefail

source_root="${CLAUDE_MEM_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
fork_root="${CLAUDE_MEM_FORK_ROOT:-/home/sk/development/tools/claude-mem}"
systemd_user_dir="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
local_bin_dir="${LOCAL_BIN_DIR:-$HOME/.local/bin}"
maintainer="$local_bin_dir/claude-mem-local-maintain"
unit_source="$source_root/ops/local-maintenance"

install -d -m 0755 "$systemd_user_dir" "$local_bin_dir"

maintainer_temp="$(mktemp "$local_bin_dir/.claude-mem-local-maintain.XXXXXX")"
service_temp="$(mktemp "$systemd_user_dir/.claude-mem-local-maintenance.service.XXXXXX")"
timer_temp="$(mktemp "$systemd_user_dir/.claude-mem-local-maintenance.timer.XXXXXX")"

cleanup() {
  rm -f "$maintainer_temp" "$service_temp" "$timer_temp"
}
trap cleanup EXIT

install -m 0755 "$source_root/scripts/claude-mem-local-maintain.sh" "$maintainer_temp"
sed \
  -e "s|@FORK_ROOT@|$fork_root|g" \
  -e "s|@MAINTAINER@|$maintainer|g" \
  "$unit_source/claude-mem-local-maintenance.service" > "$service_temp"
install -m 0644 "$unit_source/claude-mem-local-maintenance.timer" "$timer_temp"
chmod 0644 "$service_temp" "$timer_temp"

mv "$maintainer_temp" "$maintainer"
mv "$service_temp" "$systemd_user_dir/claude-mem-local-maintenance.service"
mv "$timer_temp" "$systemd_user_dir/claude-mem-local-maintenance.timer"

systemctl --user daemon-reload
systemctl --user enable --now claude-mem-local-maintenance.timer

echo "Installed claude-mem local maintenance timer"
