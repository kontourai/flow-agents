/**
 * Pure, side-effect-free validation predicates mirroring the bash Console
 * telemetry validators exactly, for the future guided console-connect wizard
 * (PR2/PR3) to reuse at prompt time. Deliberately NOT wired into `init.ts`'s
 * interactive flow in this PR — see install-flow-foundations plan, Thread D.
 *
 * Every predicate returns a plain boolean (never throws), matching the
 * "wizard re-prompts on false" use case, unlike the bash `die`-based
 * validators these mirror (which exit non-zero on failure).
 */

/**
 * Mirrors `has_control_chars` (scripts/telemetry/install-console-config.sh:43-45).
 * Rejects values containing a newline, carriage return, or tab.
 */
export function hasControlChars(value: string): boolean {
  return value.includes("\n") || value.includes("\r") || value.includes("\t");
}

/** Shared https/localhost/127.0.0.1 scheme rule used by both URL validators below. */
function isHttpsOrLocalhostUrl(value: string): boolean {
  if (value.startsWith("https://")) return true;
  if (value === "http://127.0.0.1" || value.startsWith("http://127.0.0.1:") || value.startsWith("http://127.0.0.1/")) return true;
  if (value === "http://localhost" || value.startsWith("http://localhost:") || value.startsWith("http://localhost/")) return true;
  return false;
}

/**
 * Mirrors `validate_url` (scripts/telemetry/install-console-config.sh:47-62).
 * Blank is valid (the field is optional at install time). Otherwise: no
 * control characters, and must be `https://*`, or `http://` to localhost/127.0.0.1.
 */
export function isValidConsoleUrl(value: string): boolean {
  if (value === "") return true;
  if (hasControlChars(value)) return false;
  return isHttpsOrLocalhostUrl(value);
}

/**
 * Mirrors `console_telemetry_endpoint_allowed` (scripts/telemetry/lib/transport.sh:20-28).
 * Unlike `isValidConsoleUrl`, blank is INVALID (a non-empty endpoint is
 * required at runtime-post time). This check is deliberately narrower than
 * `hasControlChars`: the bash function only rejects `\n`, `\r`, and a
 * literal `"` (the value is later embedded in a curl config file as a
 * quoted string) — it does NOT reject tab, so this must not call
 * `hasControlChars` (which also rejects tab).
 */
export function isValidConsoleEndpointStrict(value: string): boolean {
  if (value === "") return false;
  if (value.includes("\n") || value.includes("\r") || value.includes('"')) return false;
  return isHttpsOrLocalhostUrl(value);
}

const CONSOLE_TOKEN_CHARSET = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Mirrors `validate_token` (scripts/telemetry/install-console-config.sh:64-69).
 * Blank is valid (optional field). Otherwise: length <= 4096, no control
 * characters, and charset restricted to `[A-Za-z0-9._~+/=-]`.
 */
export function isValidConsoleToken(value: string): boolean {
  if (value === "") return true;
  if (value.length > 4096) return false;
  if (hasControlChars(value)) return false;
  return CONSOLE_TOKEN_CHARSET.test(value);
}

const CONSOLE_TENANT_CHARSET = /^[A-Za-z0-9._:-]+$/;

/**
 * Mirrors `validate_tenant` (scripts/telemetry/install-console-config.sh:82-86).
 * Blank is valid (optional field). Otherwise: charset restricted to
 * `[A-Za-z0-9._:-]` (no length bound at install time).
 */
export function isValidConsoleTenant(value: string): boolean {
  if (value === "") return true;
  return CONSOLE_TENANT_CHARSET.test(value);
}

/**
 * Mirrors `console_telemetry_safe_tenant` (scripts/telemetry/lib/transport.sh:35-38).
 * Unlike `isValidConsoleTenant`, non-empty is required and length is bounded
 * to 1..128 (the runtime-safety gate, stricter than the install-time validator).
 */
export function isSafeConsoleTenantForRuntime(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  return CONSOLE_TENANT_CHARSET.test(value);
}
