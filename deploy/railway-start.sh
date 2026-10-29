#!/usr/bin/env bash
# Supervise the private MCP, tunnel, and optional authenticated HA gateway.
set -euo pipefail
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in Railway Variables}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in Railway Variables}"
export MCP_SERVER_URL=http://127.0.0.1:7878/mcp
export HEALTH_LISTEN_ADDR=127.0.0.1:8080
export AULA_MCP_HOST=127.0.0.1
export AULA_MCP_PORT=7878
export AULA_MCP_WRITE=0
export AULA_MCP_RAW=0
export AULA_MCP_ATTACHMENTS_DIR=/tmp/aula-attachments
unset AULA_MCP_ALLOW_REMOTE
server_pid=""
tunnel_pid=""
gateway_pid=""
tailscale_pid=""
if [[ "${AULA_HA_ENABLED:-0}" == "1" ]]; then
  : "${AULA_HA_TOKEN:?Set a separate AULA_HA_TOKEN for Home Assistant}"
  if [[ ${#AULA_HA_TOKEN} -lt 32 ]]; then
    echo "AULA_HA_TOKEN must contain at least 32 characters" >&2
    exit 1
  fi
fi
cleanup() {
  trap - EXIT
  for pid in "$server_pid" "$tunnel_pid" "$gateway_pid" "$tailscale_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
env -u CONTROL_PLANE_API_KEY -u AULA_HA_TOKEN bun packages/mcp-server/src/server.ts &
server_pid=$!
node --input-type=module - "$server_pid" <<'NODE'
const serverPid = Number(process.argv[2]);
const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try { process.kill(serverPid, 0); }
  catch { console.error("Aula exited before becoming ready"); process.exit(1); }
  try {
    const response = await fetch("http://127.0.0.1:7878/healthz", {
      signal: AbortSignal.timeout(1000)
    });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) { console.error("Aula did not become ready within 30 seconds"); process.exit(1); }
console.log("Aula is ready; starting the private tunnel");
NODE
env -u AULA_HA_TOKEN tunnel-client run &
tunnel_pid=$!
pids=("$server_pid" "$tunnel_pid")
if [[ "${AULA_HA_ENABLED:-0}" == "1" ]]; then
  # HA is reachable only through the tailnet's Serve proxy, never Railway's edge.
  export AULA_HA_HOST=127.0.0.1
  export AULA_HA_PORT=8081
  env -u CONTROL_PLANE_API_KEY node ha-bridge/deploy/ha-gateway.mjs &
  gateway_pid=$!
  pids+=("$gateway_pid")
  env -u CONTROL_PLANE_API_KEY -u AULA_HA_TOKEN bash deploy/tailscale-start.sh &
  tailscale_pid=$!
  pids+=("$tailscale_pid")
fi
set +e
wait -n "${pids[@]}"
status=$?
if [[ "$status" -eq 0 ]]; then status=1; fi
exit "$status"
