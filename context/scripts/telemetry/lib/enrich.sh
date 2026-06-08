#!/usr/bin/env bash
# enrich.sh — Metadata enrichment functions

enrich_system() {
  [[ "$TELEMETRY_ENRICH_SYSTEM" != "true" ]] && echo '{}' && return
  
  local os os_version shell runtime_version node_version
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  os_version=$(uname -r)
  shell=$(basename "${SHELL:-unknown}")
  runtime_version=$(
    kiro-cli --version 2>/dev/null &
    _pid=$!; ( sleep 2; kill $_pid 2>/dev/null ) &
    _guard=$!; wait $_pid 2>/dev/null; kill $_guard 2>/dev/null
    wait $_pid 2>/dev/null
  ) 2>/dev/null
  runtime_version=$(echo "$runtime_version" | head -n1)
  runtime_version="${runtime_version:-unknown}"
  node_version=$(node --version 2>/dev/null || echo "unknown")
  
  jq -nc \
    --arg os "$os" \
    --arg osv "$os_version" \
    --arg shell "$shell" \
    --arg rv "$runtime_version" \
    --arg nv "$node_version" \
    '{
      os: $os,
      os_version: $osv,
      shell: $shell,
      runtime_version: $rv,
      node_version: $nv
    }'
}

enrich_workspace() {
  [[ "$TELEMETRY_ENRICH_WORKSPACE" != "true" ]] && echo '{}' && return
  
  local session_id cache_file
  session_id=$(session_get)
  cache_file="${TELEMETRY_SESSION_DIR}/${session_id}.workspace"
  
  # Return cached if exists
  [[ -f "$cache_file" ]] && cat "$cache_file" && return
  
  local has_git="false" git_branch="" git_hash=""
  local file_count=0 workspace_size_mb=0 primary_languages=""
  
  if git rev-parse --git-dir >/dev/null 2>&1; then
    has_git="true"
    git_branch=$(git branch --show-current 2>/dev/null || echo "unknown")
    git_hash=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    
    # Only scan files inside a git repo to avoid scanning ~ or /
    file_count=$(find . -maxdepth 4 -type f 2>/dev/null | head -10000 | wc -l | tr -d ' ')
    primary_languages=$(find . -maxdepth 4 \( -name "*.js" -o -name "*.ts" -o -name "*.py" -o -name "*.sh" -o -name "*.go" -o -name "*.rs" \) 2>/dev/null | \
      head -5000 | sed 's/.*\.//' | sort | uniq -c | sort -nr | head -3 | awk '{print $2}' | tr '\n' ',' | sed 's/,$//')
  fi
  
  local result
  result=$(jq -nc \
    --argjson hg "$has_git" \
    --arg gb "$git_branch" \
    --arg gh "$git_hash" \
    --argjson fc "$file_count" \
    --argjson ws "$workspace_size_mb" \
    --arg pl "$primary_languages" \
    '{
      has_git: $hg,
      git_branch_hash: ($gb + "@" + $gh),
      file_count: $fc,
      workspace_size_mb: $ws,
      primary_languages: $pl
    }')
  
  echo "$result" | tee "$cache_file"
}

enrich_auth() {
  [[ "$TELEMETRY_ENRICH_AUTH" != "true" ]] && echo '{}' && return
  
  local mwinit_active="false" mwinit_age_minutes=0 cookie_exists="false"
  
  # Check mwinit status
  if command -v mwinit >/dev/null 2>&1; then
    if mwinit status >/dev/null 2>&1; then
      mwinit_active="true"
      local mwinit_file="$HOME/.mwinit"
      if [[ -f "$mwinit_file" ]]; then
        local mwinit_mtime current_time
        # Try GNU stat first, then BSD
        if stat -c %Y "$mwinit_file" >/dev/null 2>&1; then
          mwinit_mtime=$(stat -c %Y "$mwinit_file")
        else
          mwinit_mtime=$(stat -f %m "$mwinit_file" 2>/dev/null || echo "0")
        fi
        current_time=$(date +%s)
        mwinit_age_minutes=$(((current_time - mwinit_mtime) / 60))
      fi
    fi
  fi
  
  # Check for auth cookies
  [[ -f "$HOME/.aws/sso/cache" ]] && cookie_exists="true"
  
  jq -nc \
    --argjson ma "$mwinit_active" \
    --argjson mam "$mwinit_age_minutes" \
    --argjson ce "$cookie_exists" \
    '{
      mwinit_active: $ma,
      mwinit_age_minutes: $mam,
      cookie_exists: $ce
    }'
}
