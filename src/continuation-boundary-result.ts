const VERIFIED_CONTINUATION_BOUNDARY = Symbol("verified-continuation-boundary");

type BoundaryResult = {
  status: "completed";
  completion_reason: "gate_boundary";
  summary?: string;
  evidence?: Record<string, unknown>;
};

export function markVerifiedContinuationBoundary<T extends BoundaryResult>(result: T): T {
  Object.defineProperty(result, VERIFIED_CONTINUATION_BOUNDARY, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function isVerifiedContinuationBoundary(value: unknown): value is BoundaryResult {
  return Boolean(value && typeof value === "object"
    && (value as Record<PropertyKey, unknown>)[VERIFIED_CONTINUATION_BOUNDARY] === true);
}
