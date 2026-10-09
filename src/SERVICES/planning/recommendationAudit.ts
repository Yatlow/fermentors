/**
 * Immutable evidence model for recommendation → decision → execution audits.
 * Never reconstruct an old recommendation from today's inventory or tank state.
 * Only captured snapshots are eligible for historical accuracy metrics.
 */
export type RecommendationKind = "shipment" | "packaging" | "brewing";

export type RecommendationEvidence = {
  id: string;
  weekId: string;
  kind: RecommendationKind;
  capturedAt: string;
  /** Stable algorithm revision, so changes in logic can be compared fairly. */
  algorithmVersion: string;
  /** Existing decisions may predate the first recorded recommendation. */
  provenance?: "decision-time" | "existing-plan-baseline" | "recomputed-at-save";
  /** Canonical recommendation payload captured at decision time. */
  recommended: Record<string, unknown>[];
  /** Decision payload captured alongside the recommendation. */
  decided: Record<string, unknown>[];
};

export type AuditAvailability =
  | { status: "available"; evidence: RecommendationEvidence }
  | { status: "missing"; reason: "no-historical-snapshot" | "invalid-snapshot" };

/** Legacy plans without recorded recommendations must remain unscored. */
export function recommendationAuditAvailability(
  value: unknown,
): AuditAvailability {
  if (value == null) return { status: "missing", reason: "no-historical-snapshot" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { status: "missing", reason: "invalid-snapshot" };
  }
  const snapshot = value as Partial<RecommendationEvidence>;
  if (
    typeof snapshot.id !== "string" || !snapshot.id ||
    typeof snapshot.weekId !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.weekId) ||
    !["shipment", "packaging", "brewing"].includes(snapshot.kind ?? "") ||
    typeof snapshot.capturedAt !== "string" || !snapshot.capturedAt ||
    typeof snapshot.algorithmVersion !== "string" || !snapshot.algorithmVersion ||
    !Array.isArray(snapshot.recommended) || !Array.isArray(snapshot.decided) ||
    !snapshot.recommended.every(isRecord) || !snapshot.decided.every(isRecord)
  ) return { status: "missing", reason: "invalid-snapshot" };
  if (snapshot.provenance !== "decision-time") {
    return { status: "missing", reason: "no-historical-snapshot" };
  }
  return { status: "available", evidence: snapshot as RecommendationEvidence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
