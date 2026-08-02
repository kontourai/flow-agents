import { runtimeError } from "./runtime-session-core.js";

const SECRET_REPLACEMENTS = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "<SECRET>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<SECRET>"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<SECRET>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<SECRET>"],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, "<SECRET>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<SECRET>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<SECRET>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<SECRET>"],
  [
    /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
    "$1<SECRET>$2",
  ],
  [
    /["']?((?:[a-z][a-z0-9]*[_-])*(?:secret|password|pwd|passphrase|credentials?|token|api[_-]?key|authorization|account[_-]?key|shared[_-]?access[_-]?(?:key|signature)|client[_-]?secret|access[_-]?key|private[_-]?key|connection[_-]?string|sas[_-]?token)(?:[_-][a-z0-9]+)*)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:bearer\s+)?[^\s"'};,]{8,})/gi,
    "$1=<SECRET>",
  ],
];

const SENSITIVE_FIELD_NAME = /^(?:(?:[a-z][a-z0-9]*[_-])*(?:secret|password|pwd|passphrase|credentials?|token|api[_-]?key|authorization|account[_-]?key|shared[_-]?access[_-]?(?:key|signature)|client[_-]?secret|access[_-]?key|private[_-]?key|connection[_-]?string|sas[_-]?token)(?:[_-][a-z0-9]+)*)$/i;

/** Deterministic defense-in-depth scrub applied before runtime residue exits. */
export function scrubRuntimeResidueText(value) {
  let text = String(value ?? "");
  text = text.replace(
    /\b[A-Z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`]+)*/gi,
    "<HOME_PATH>",
  );
  text = text.replace(
    /\/(?:Users|home)\/[^/\s"'`]+(?:\/[^\s"'`]+)*/g,
    "<HOME_PATH>",
  );
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "<EMAIL>",
  );
  return text;
}

function scrubStructuredToolValue(value, fieldName = "") {
  if (SENSITIVE_FIELD_NAME.test(fieldName)) return "<SECRET>";
  if (typeof value === "string") return scrubRuntimeResidueText(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubStructuredToolValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubStructuredToolValue(item, key)]),
    );
  }
  return value;
}

export function formatToolPayload(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw runtimeError(
        "UNKNOWN_TRANSCRIPT_FORMAT",
        "tool arguments are not valid structured JSON",
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runtimeError(
      "UNKNOWN_TRANSCRIPT_FORMAT",
      "tool arguments must be a structured object",
    );
  }
  return JSON.stringify(scrubStructuredToolValue(parsed));
}
