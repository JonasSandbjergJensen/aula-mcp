#!/usr/bin/env bash
# Supervise both processes; Railway restarts the container if either exits.
set -euo pipefail
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in Railway Variables}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in Railway Variables}"
export MCP_SERVER_URL=http://127.0.0.1:7878/mcp
export HEALTH_LISTEN_ADDR=127.0.0.1:8080
export AULA_MCP_HOST=127.0.0.1
export AULA_MCP_PORT=7878
export AULA_MCP_WRITE=0
export AULA_MCP_RAW=0
unset AULA_MCP_ALLOW_REMOTE
server_pid=""
tunnel_pid=""
cleanup() {
  trap - EXIT
  for pid in "$server_pid" "$tunnel_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
env -u CONTROL_PLANE_API_KEY bun packages/mcp-server/src/server.ts &
server_pid=$!
tunnel-client run &
tunnel_pid=$!
set +e
wait -n "$server_pid" "$tunnel_pid"
status=$?
# A long-running component exiting cleanly is still an unexpected shutdown.
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
