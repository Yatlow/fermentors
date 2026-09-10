import { useState } from "react";
import type { DailySuggestion } from "../../SERVICES/planning/dailyPlanner";
import { shortDate } from "../../SERVICES/planning/dailyPlanner";
import { MAX_TRUCK_SLOTS } from "../../SERVICES/cooler/truckCapacity";
import { markPlanningPallets } from "../../SERVICES/planning/picking";
export default function TruckRecommendations({
  suggestions,
  disabled = false,
}: {
  suggestions: DailySuggestion[];
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const trucks = [
    ...new Set(
      suggestions.filter((s) => s.kind === "delivery").map((s) => s.truckId),
    ),
  ];
  return (
    <>
      {message && <p role="status">{message}</p>}
      {trucks.map((id) => {
        const rows = suggestions.filter(
            (s) => s.kind === "delivery" && s.truckId === id,
          ),
          first = rows[0],
          pallets = rows.flatMap((s) => s.pallets ?? []),
          real = pallets.filter((p) => !p.id.startsWith("planning:"));
        return (
          <section className="bp-truck" key={id}>
            <h4>משלוח לטמפו · {shortDate(first.date)}</h4>
            <p>{first.reason}</p>
            {rows.map((r) => (
              <p key={r.id}>
                <b>
                  {r.pallets?.[0]?.beerStyle ?? r.productId} · {r.quantity}{" "}
                  {r.pallets?.[0]?.itemType === "crates" ? "ארגזים" : "חביות"}
                </b>
              </p>
            ))}
            <small>
              קליטה משוערת: {shortDate(first.arrivalDate!)} · {first.slots}{" "}
              מקומות מתוך {MAX_TRUCK_SLOTS}. אין השלמת משאית ללא צורך במלאי.
            </small>
            <details>
              <summary>משטחים לליקוט ונתוני קיבולת</summary>
              {pallets.map((p) => (
                <div className="bp-plan-line" key={p.id}>
                  <b>
                    {p.beerStyle} · {p.quantity}{" "}
                    {p.itemType === "crates" ? "ארגזים" : "חביות"}
                  </b>
                  <small>
                    {p.id.startsWith("planning:")
                      ? "משטח עתידי משוער — לא ניתן לסימון"
                      : `משטח ${p.palletNumber ?? p.id.slice(-6)} · אצווה ${p.batchNumber ?? "—"}`}
                  </small>
                  <small>
                    תוקף {p.expiryDateStr ?? "—"}
                    {p.markedForShipment ? " · מסומן לליקוט" : ""}
                  </small>
                </div>
              ))}
              <button
                disabled={
                  disabled ||
                  busy ||
                  !real.length ||
                  real.every((p) => p.markedForShipment)
                }
                onClick={async () => {
                  setBusy(true);
                  setMessage("");
                  try {
                    await markPlanningPallets(real);
                    setMessage(
                      "המשטחים הקיימים סומנו למשלוח במפת המקרר. זו אינה הוצאה מהמלאי או אישור תוכנית.",
                    );
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : "הסימון נכשל");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                סימון {real.length} משטחים קיימים לליקוט
              </button>
              <small>
                מעדכן את הסימון הקיים במפת המקרר בלבד. משטחים עתידיים אינם
                נכללים.
              </small>
            </details>
          </section>
        );
      })}
    </>
  );
}
