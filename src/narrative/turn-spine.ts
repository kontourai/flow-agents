export const TURN_SPINE_RULE_ID = "turn-spine/v1" as const;
export const QUARANTINE_SESSION_ID = "quarantine" as const;

export interface ResolvedTelemetryRecord {
  sourceId: string;
  record: Record<string, unknown>;
}

export interface TurnBoundary {
  derived: boolean;
  rule_id?: typeof TURN_SPINE_RULE_ID;
}

export interface Turn {
  ordinal: number;
  sessionId: string;
  turnId?: string;
  boundary: TurnBoundary;
  sources: string[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hookTurnId(record: Record<string, unknown>): string | undefined {
  const hook = record["hook"];
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return undefined;
  return nonEmptyString((hook as Record<string, unknown>)["turn_id"]);
}

/** Correlate frozen telemetry records without consulting a live runtime store. */
export function buildTurnSpine(records: readonly ResolvedTelemetryRecord[]): Turn[] {
  const turns: Turn[] = [];
  const explicitBySession = new Map<string, Map<string, Turn>>();
  const derivedBySession = new Map<string, Turn>();
  const quarantineSources: string[] = [];

  const createTurn = (sessionId: string, turnId?: string): Turn => {
    const boundary: TurnBoundary = turnId
      ? { derived: false }
      : { derived: true, rule_id: TURN_SPINE_RULE_ID };
    const turn: Turn = {
      ordinal: turns.length,
      sessionId,
      ...(turnId ? { turnId } : {}),
      boundary,
      sources: [],
    };
    turns.push(turn);
    return turn;
  };

  for (const input of records) {
    const sessionId = nonEmptyString(input.record?.["session_id"]);
    if (!sessionId) {
      quarantineSources.push(input.sourceId);
      continue;
    }

    const turnId = hookTurnId(input.record);
    if (turnId) {
      let byTurnId = explicitBySession.get(sessionId);
      if (!byTurnId) {
        byTurnId = new Map<string, Turn>();
        explicitBySession.set(sessionId, byTurnId);
      }
      let turn = byTurnId.get(turnId);
      if (!turn) {
        turn = createTurn(sessionId, turnId);
        byTurnId.set(turnId, turn);
      }
      turn.sources.push(input.sourceId);
      // Review H1: an explicit turn is a boundary for the session's derived
      // spine too — close any active derived turn so a later spine-less event
      // starts a fresh turn instead of merging across this boundary.
      derivedBySession.delete(sessionId);
      continue;
    }

    let turn = derivedBySession.get(sessionId);
    if (!turn || input.record["event_type"] === "turn.user") {
      turn = createTurn(sessionId);
      derivedBySession.set(sessionId, turn);
    }
    turn.sources.push(input.sourceId);
  }

  if (quarantineSources.length > 0) {
    turns.push({
      ordinal: -1,
      sessionId: QUARANTINE_SESSION_ID,
      boundary: { derived: true, rule_id: TURN_SPINE_RULE_ID },
      sources: quarantineSources,
    });
  }

  return turns;
}
