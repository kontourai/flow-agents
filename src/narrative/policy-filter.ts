/** Mirrors scripts/telemetry/lib/config.sh TELEMETRY_CHANNEL_FULL_REDACT. */
export const TELEMETRY_CHANNEL_FULL_REDACT_DEFAULT = ["hook.raw_input", "turn.prompt_text", "tool.input", "tool.output"] as const;

/** Mirrors scripts/telemetry/lib/config.sh TELEMETRY_CHANNEL_ANALYTICS_REDACT. */
export const TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT = [
  "tool.input", "tool.output", "turn.prompt_text", "delegation.targets.query",
  "context.cwd", "hook.raw_input", "hook.last_assistant_message", "hook.transcript_path",
] as const;

export type NarrativePolicyFilterResult =
  | { kind: "filtered"; record: Record<string, unknown>; redactions: string[] }
  | { kind: "redacted"; fields: string[]; diagnostic: string };

function uniqueFields(fields: readonly string[]): string[] {
  return [...new Set(fields.map((field) => field.trim()).filter(Boolean))];
}

export function effectiveNarrativeRedactionFields(narrativeFields: readonly string[] = []): string[] {
  return uniqueFields([...TELEMETRY_CHANNEL_FULL_REDACT_DEFAULT, ...narrativeFields]);
}

function failure(fields: readonly string[], diagnostic: string): NarrativePolicyFilterResult {
  return { kind: "redacted", fields: uniqueFields(fields), diagnostic };
}

export function filterNarrativeRecord(
  input: unknown,
  effectiveFields: readonly string[] | null | undefined,
): NarrativePolicyFilterResult {
  if (!Array.isArray(effectiveFields)) return failure([], "redaction policy is unresolvable");
  const fields = uniqueFields(effectiveFields);
  if (fields.some((field) => !field.split(".").every((part) => part.length > 0 && part !== "__proto__" && part !== "prototype" && part !== "constructor"))) {
    return failure(fields, `redaction policy contains an invalid field name: ${fields.join(", ")}`);
  }

  let parsed: unknown;
  try {
    parsed = typeof input === "string" || Buffer.isBuffer(input) ? JSON.parse(input.toString()) : structuredClone(input);
  } catch {
    return failure(fields, `record could not be parsed under fields: ${fields.join(", ")}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure(fields, `record is not an object under fields: ${fields.join(", ")}`);

  const record = parsed as Record<string, unknown>;
  try {
    for (const field of fields) {
      const parts = field.split(".");
      let cursor: Record<string, unknown> = record;
      for (const part of parts.slice(0, -1)) {
        const next = cursor[part];
        if (next === undefined || next === null) {
          cursor[part] = {};
          cursor = cursor[part] as Record<string, unknown>;
        } else if (typeof next === "object" && !Array.isArray(next)) {
          cursor = next as Record<string, unknown>;
        } else {
          throw new Error(field);
        }
      }
      cursor[parts.at(-1)!] = null;
    }
  } catch {
    return failure(fields, `field nulling failed for fields: ${fields.join(", ")}`);
  }
  return { kind: "filtered", record, redactions: fields };
}
