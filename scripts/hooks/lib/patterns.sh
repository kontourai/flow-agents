#!/usr/bin/env bash
# patterns.sh — Shared detection patterns for governance audit
# Compatible with bash 3.2+ (no associative arrays)

# --- Secret patterns ---
_detect_secrets() {
  local text="$1"
  local found=""
  echo "$text" | grep -qE 'AKIA[A-Z0-9]{16}' 2>/dev/null && found="${found}aws_key "
  echo "$text" | grep -qE 'ASIA[A-Z0-9]{16}' 2>/dev/null && found="${found}aws_sts "
  echo "$text" | grep -qE '(secret|password|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}' 2>/dev/null && found="${found}generic_secret "
  echo "$text" | grep -q 'BEGIN.*PRIVATE KEY' 2>/dev/null && found="${found}private_key "
  echo "$text" | grep -qE 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' 2>/dev/null && found="${found}jwt "
  echo "$text" | grep -qE 'gh[pousr]_[A-Za-z0-9_]{36,}' 2>/dev/null && found="${found}github_token "
  # Output one per line (trimmed)
  for t in $found; do echo "$t"; done
}

# --- AWS policy violation patterns (from internal-rules.md) ---
_detect_aws_violations() {
  local text="$1"
  local found=""
  echo "$text" | grep -qE '0\.0\.0\.0/0' 2>/dev/null && found="${found}open_cidr "
  echo "$text" | grep -qF '::/0' 2>/dev/null && found="${found}open_ipv6 "
  echo "$text" | grep -qEi 'PublicRead|public-read|PublicReadWrite|public-read-write' 2>/dev/null && found="${found}public_acl "
  echo "$text" | grep -qEi 'BlockPublicAccess.*false|block_public_access.*false' 2>/dev/null && found="${found}block_public_false "
  echo "$text" | grep -qE '"Effect"[[:space:]]*:[[:space:]]*"Allow".*"Principal"[[:space:]]*:[[:space:]]*"\*"' 2>/dev/null && found="${found}wildcard_principal "
  echo "$text" | grep -qE '"Scheme"[[:space:]]*:[[:space:]]*"internet-facing"' 2>/dev/null && found="${found}internet_facing "
  echo "$text" | grep -qEi 'AssignPublicIp.*ENABLED|assign_public_ip.*true' 2>/dev/null && found="${found}public_ip "
  echo "$text" | grep -qE '"EndpointType"[[:space:]]*:[[:space:]]*"EDGE"' 2>/dev/null && found="${found}public_apigw "
  for t in $found; do echo "$t"; done
}

# --- Destructive command patterns ---
_detect_destructive_ops() {
  local text="$1"
  echo "$text" | grep -qEi 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f|rm[[:space:]]+-[a-zA-Z]*f[a-zA-Z]*r' 2>/dev/null && return 0
  echo "$text" | grep -qEi 'git[[:space:]]+push[[:space:]]+.*--force' 2>/dev/null && return 0
  echo "$text" | grep -qEi 'git[[:space:]]+reset[[:space:]]+--hard' 2>/dev/null && return 0
  echo "$text" | grep -qEi 'DROP[[:space:]]+TABLE' 2>/dev/null && return 0
  echo "$text" | grep -qEi 'DELETE[[:space:]]+FROM' 2>/dev/null && return 0
  return 1
}

# --- Sensitive file path patterns ---
_detect_sensitive_paths() {
  local text="$1"
  echo "$text" | grep -qEi '\.env|credentials|\.pem$|\.key$|id_rsa' 2>/dev/null && return 0
  return 1
}

# --- Elevated privilege patterns ---
_detect_elevated_privilege() {
  local text="$1"
  echo "$text" | grep -qE 'sudo[[:space:]]+|\bchmod[[:space:]]+|\bchown[[:space:]]+' 2>/dev/null && return 0
  return 1
}
