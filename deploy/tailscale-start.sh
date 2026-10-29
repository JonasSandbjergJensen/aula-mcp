#!/usr/bin/env bash
# A persistent private node. Never advertises subnets, an exit node, SSH or Funnel.
set -euo pipefail
umask 077
state_dir="${AULA_TAILSCALE_STATE_DIR:-/data/tailscale}"
socket="${AULA_TAILSCALE_SOCKET:-/tmp/aula-tailscaled.sock}"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
daemon_pid=""
client_pid=""
cleanup() {
  trap - EXIT
  for pid in "$client_pid" "$daemon_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
tailscaled --tun=userspace-networking --statedir="$state_dir" \
  --state="$state_dir/tailscaled.state" --socket="$socket" &
daemon_pid=$!
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$daemon_pid" 2>/dev/null || exit 1
  if tailscale --socket="$socket" status --json >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then echo "Tailscale socket was not ready" >&2; exit 1; fi
while true; do
  tailscale --socket="$socket" up --hostname=aula-bridge \
    --advertise-tags=tag:aula-bridge --accept-dns=false --accept-routes=false \
    --timeout=60s &
  client_pid=$!
  if wait "$client_pid"; then client_pid=""; break; fi
  client_pid=""
  kill -0 "$daemon_pid" 2>/dev/null || exit 1
  echo "Aula private node is waiting for Tailscale login; ChatGPT remains available."
  sleep 15
done
# Only a private HTTPS proxy to the authenticated loopback gateway.
# If HTTPS needs enabling, the CLI prints a consent link for the account owner.
while true; do
  tailscale --socket="$socket" serve --bg --yes --https=443 http://127.0.0.1:8081 &
  client_pid=$!
  if wait "$client_pid"; then client_pid=""; break; fi
  client_pid=""
  kill -0 "$daemon_pid" 2>/dev/null || exit 1
  echo "Aula private HTTPS proxy is waiting for Tailscale HTTPS setup."
  sleep 15
done
tailscale --socket="$socket" serve status
echo "Aula private HTTPS proxy is configured; verify it from Home Assistant."
set +e
wait "$daemon_pid"
status=$?
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
