import type { GroundedExecutionNarrative } from "./envelope.js";

function refs(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(" ");
}

/** Render only statements already present in the grounded envelope. */
export function renderGroundedNarrative(envelope: GroundedExecutionNarrative): string {
  const lines: string[] = [
    "# Grounded Execution Narrative",
    "",
    "## Authority provenance",
    "",
  ];
  for (const section of envelope.sections) {
    if (section.authority === "flow-agents") continue;
    lines.push(`- ${section.authority} supplied ${section.kind} (${section.sha256}). ${refs(section.source_refs)}`);
  }

  const runtime = envelope.sections.find((section) => section.authority === "flow-agents");
  if (runtime?.authority === "flow-agents") {
    lines.push("", "## Runtime turns", "");
    for (const turn of runtime.embedded.turns) {
      lines.push(`### Turn ${turn.ordinal}`, "");
      if (turn.statements.length === 0) lines.push("_No factual statements were captured for this turn._", "");
      for (const statement of turn.statements) {
        const actor = statement.actor ? ` (${statement.actor})` : "";
        lines.push(`- ${statement.proposition}${actor}. \`${statement.id}\``);
      }
      lines.push("");
    }
    if (runtime.embedded.document_statements.length > 0) {
      lines.push("## Document observations", "");
      for (const statement of runtime.embedded.document_statements) {
        const actor = statement.actor ? ` (${statement.actor})` : "";
        lines.push(`- ${statement.proposition}${actor}. \`${statement.id}\``);
      }
      lines.push("");
    }
  }

  lines.push("## Correlation", "");
  for (const turn of envelope.correlation.turns) {
    if (turn.placed.length === 0) continue;
    lines.push(`### Turn ${turn.turn_ordinal}`, "");
    for (const placed of turn.placed) {
      lines.push(`- Flow transitioned from ${placed.from} to ${placed.to}${placed.at ? ` at ${placed.at}` : ""} (${placed.rule.id}). ${refs(placed.source_refs)}`);
    }
    lines.push("");
  }
  lines.push("### Unplaced", "");
  if (envelope.correlation.unplaced.length === 0) lines.push("_None._", "");
  for (const transition of envelope.correlation.unplaced) {
    lines.push(`- Flow transition ${transition.from} to ${transition.to} was unplaced (${transition.reason}). ${refs(transition.source_refs)}`);
  }

  lines.push("## Conclusions", "");
  if (envelope.conclusions.length === 0) lines.push("_None._", "");
  for (const conclusion of envelope.conclusions) {
    const grounding = conclusion.grounding.kind === "flow_gate_derivation"
      ? `${conclusion.grounding.kind} ${conclusion.grounding.pointer}`
      : conclusion.grounding.kind;
    lines.push(`- ${conclusion.proposition} (${grounding}) \`${conclusion.grounding.source_ref}\``);
  }

  lines.push("## Unavailable sources", "");
  if (envelope.unavailable_sources.length === 0) lines.push("_None._", "");
  for (const source of envelope.unavailable_sources) {
    lines.push(`- Source was unavailable (${source.reason}). \`${source.source_ref}\``);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
