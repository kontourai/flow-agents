#!/usr/bin/env bash
# usage_model_guard.sh — shared usage.model/usage.numeric validation constants
# (#568 slice 1 security review, HIGH + LOW findings).
#
# HIGH: a charset-only check (e.g. `^[A-Za-z0-9._:-]+$`, <=128 chars) is a
# STRICT SUPERSET of common secret/credential shapes -- an Anthropic API key
# (`sk-ant-api03-...`), an AWS access key (`AKIA...`), or a JWT (`eyJ...`,
# often with an embedded email) all satisfy that charset and would pass
# through verbatim into usage.model. A model id must instead match a small,
# known VENDOR-PREFIX ALLOWLIST (case-insensitive) and stay under a much
# tighter length bound. Sourced by BOTH usage.sh (the primary extractor,
# usage_last_turn_usage) and transport.sh (the defense-in-depth backstop,
# console_telemetry_sanitize_usage) so the pattern is defined in exactly ONE
# place -- never hand-copied into two jq programs that could drift apart.
#
# LOW: a `type=="number"` check alone accepts negative and absurd-magnitude
# values (e.g. -1, 1e308) as if they were real token counts / costs. Every
# numeric usage field must additionally satisfy a sane [min, max] bound.
# Same shared-constant discipline: defined once, used by both usage.sh and
# transport.sh.
USAGE_MODEL_MAX_LEN=40
# jq regex source. IMPORTANT: matched CASE-SENSITIVELY (plain `test($regex)`,
# NO "i" flag) at both call sites — the suffix is `[a-z0-9]` (lowercase+digit)
# ON PURPOSE, so an uppercase run (AWS `AKIA...`, mixed-case JWT `eyJ...`)
# cannot appear even when a secret is prefixed with a vendor token.
#
# The suffix is also STRUCTURED like a real version string, not free text: a
# known vendor prefix, then zero or more `[-._:]`-separated tokens each at most
# 16 chars. This closes the earlier "prefix-only allowlist" gap where a secret
# wearing a vendor prefix (`claude-UPPERCASE-REJECTED`, or a long lowercase
# token) still passed a bare `[a-z0-9._:-]*` suffix. Legitimate model ids this
# keeps matching: claude-opus-4-8, claude-3-5-sonnet-20241022, claude-fable-5,
# gpt-5, gpt-4o-2024-08-06, o1, gemini-2.0, glm-5.2. Anything else → "unknown".
#
# Residual (accepted, tracked): a caller that FULLY controls the transcript
# could still pack <=40 chars of lowercase dash-separated text into .model.
# That requires complete transcript forgery (already in-session code exec),
# .model is display-only, and the transport backstop is defense-in-depth.
USAGE_MODEL_REGEX='^(claude|gpt|o[0-9]|gemini|glm|llama|mistral|deepseek|qwen|grok|command|codestral)([._:-][a-z0-9]{1,16})*$'

USAGE_NUMERIC_MIN=0
USAGE_NUMERIC_MAX=1000000000000
