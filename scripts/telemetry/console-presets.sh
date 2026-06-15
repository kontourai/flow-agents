#!/usr/bin/env bash
# Named Console telemetry sink defaults used by install/setup helpers.

flow_agents_local_kontour_console_url() {
  printf '%s\n' "${FLOW_AGENTS_LOCAL_KONTOUR_CONSOLE_URL:-http://127.0.0.1:3737}"
}

flow_agents_kontour_cloud_console_url() {
  printf '%s\n' "${FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL:-https://console.kontourai.io}"
}

flow_agents_kontour_hosted_console_url() {
  flow_agents_kontour_cloud_console_url
}
