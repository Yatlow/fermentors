import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import type {
  SandboxBrewRun,
  SandboxDemoTank,
} from "../../SERVICES/brewing/brewingSandbox";
import type { PlannedBrewHint } from "../../SERVICES/brewing/planningBrewHints";

type Props = {
  open: boolean;
  tanks: Fermentor[];
  recipes: BrewRecipe[];
  suggestedBatch: string;
  sandboxRuns: SandboxBrewRun[];
  demoTank: SandboxDemoTank;
  busyTankId: string | null;
  planningHints: PlannedBrewHint[];
  planningHintsAvailable: boolean;
  onClose: () => void;
  onDemoTankTypeChange: (value: SandboxDemoTank["tankType"]) => void;
  onCreate: (
    tank: Fermentor,
    draft: { batchNumber: string; style: string },
  ) => Promise<void>;
};

function tankKind(tank: Fermentor, demoTank: SandboxDemoTank) {
  if (tank.id === demoTank.id) {
    return demoTank.tankType === "single"
      ? "בודד"
      : demoTank.tankType === "double"
        ? "כפול"
        : "משולש";
  }

  const n = Number(tank.tankNumber);
  if (n < 5) return "בודד";
  if (n < 9) return "כפול";
  return "משולש";
}

function statusLabel(tank: Fermentor) {
  if (Number(tank.action) === 5) return "מחוטא";
  if (Number(tank.action) === 0) return "בישול חדש";
  return String(tank.stage?.name || "לא ידוע");
}

function statusRank(tank: Fermentor) {
  const status = statusLabel(tank);
  if (status === "מחוטא") return 0;
  if (status === "נקי") return 1;
  if (status === "מלוכלך" || status === "מלוכלך/ריק") return 2;
  if (status === "בישול חדש") return 3;
  if (status === "בתסיסה") return 4;
  if (status === "קר") return 5;
  return 6;
}

export default function CreateBrewModal({
  open,
  tanks,
  recipes,
  suggestedBatch,
  sandboxRuns,
  demoTank,
  busyTankId,
  planningHints,
  planningHintsAvailable,
  onClose,
  onDemoTankTypeChange,
  onCreate,
}: Props) {
  const sortedTanks = useMemo(
    () =>
      [...tanks].sort(
        (a, b) =>
          statusRank(a) - statusRank(b) ||
          Number(a.tankNumber) - Number(b.tankNumber),
      ),
    [tanks],
  );

  const [batchNumber, setBatchNumber] = useState(suggestedBatch);
  const [tankId, setTankId] = useState("");
  const [style, setStyle] = useState("");

  useEffect(() => {
    if (!open) return;
    setBatchNumber(suggestedBatch);
    setTankId((current) =>
      current && sortedTanks.some((tank) => tank.id === current)
        ? current
        : sortedTanks[0]?.id || "",
    );
    setStyle((current) =>
      current && recipes.some((recipe) => recipe.style === current)
        ? current
        : recipes[0]?.style || "",
    );
  }, [open, suggestedBatch, sortedTanks, recipes]);

  if (!open) return null;

  const selectedTank =
    sortedTanks.find((tank) => tank.id === tankId) || null;
  const isSanitized = Number(selectedTank?.action) === 5;
  const queue = selectedTank
    ? sandboxRuns
        .filter(
          (run) =>
            String(run.tankNumber) ===
              String(selectedTank.tankNumber ?? selectedTank.id) &&
            (run.assignmentStatus || "assigned") ===
              "pending_sanitization",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];

  const busy = !!selectedTank && busyTankId === selectedTank.id;

  return (
    <div
      className="brew-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="brew-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brew-create-title"
      >
        <div className="brew-modal-header">
          <div>
            <h2 id="brew-create-title">יצירת בישול חדש</h2>
            <p>מספר האצווה מוצע אוטומטית וניתן לשינוי.</p>
          </div>
          <button
            type="button"
            className="brew-modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label="סגירה"
          >
            ×
          </button>
        </div>

        {planningHintsAvailable && planningHints.length > 0 && (
          <div className="brew-planning-hint">
            <strong>בתכנון השבוע:</strong>
            <span>
              {planningHints
                .map((hint) => {
                  const tank = tanks.find(
                    (item) => item.id === hint.tankId,
                  );
                  const tankText = tank?.tankNumber
                    ? ` · מיכל ${tank.tankNumber}`
                    : "";
                  return `#${hint.batchNumber} ${hint.style}${tankText}`;
                })
                .join("  |  ")}
            </span>
          </div>
        )}

        <div className="brew-modal-fields">
          <label>
            מספר אצווה
            <input
              inputMode="numeric"
              value={batchNumber}
              onChange={(event) =>
                setBatchNumber(event.target.value.replace(/\D/g, ""))
              }
            />
          </label>

          <label>
            מיכל יעד
            <select
              value={tankId}
              onChange={(event) => setTankId(event.target.value)}
            >
              {sortedTanks.map((tank) => {
                const currentBatch =
                  Number(tank.action) <= 1
                    ? String(tank.batchNumber || "").trim()
                    : "";
                return (
                  <option key={tank.id} value={tank.id}>
                    {[
                      `מיכל ${String(tank.tankNumber ?? tank.id)}`,
                      tankKind(tank, demoTank),
                      statusLabel(tank),
                      currentBatch
                        ? `אצווה ${currentBatch}`
                        : "פנוי",
                    ].join(" · ")}
                  </option>
                );
              })}
            </select>
          </label>

          {selectedTank?.id === demoTank.id && (
            <label>
              גודל מיכל דמו
              <select
                value={demoTank.tankType}
                onChange={(event) =>
                  onDemoTankTypeChange(
                    event.target.value as SandboxDemoTank["tankType"],
                  )
                }
              >
                <option value="single">בודד</option>
                <option value="double">כפול</option>
                <option value="triple">משולש</option>
              </select>
            </label>
          )}

          <label>
            מתכון
            <select
              value={style}
              onChange={(event) => setStyle(event.target.value)}
            >
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.style}>
                  {recipe.style}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedTank && queue.length > 0 && (
          <div className="brewing-tank-queue">
            <strong>
              כבר ממתינות למיכל הזה {queue.length} אצוות:
            </strong>
            {queue.map((run, index) => (
              <span key={run.batchNumber}>
                {index + 1}. #{run.batchNumber} · {run.style}
              </span>
            ))}
          </div>
        )}

        {selectedTank && !isSanitized && (
          <div className="brewing-assignment-warning">
            האצווה תיווצר עכשיו, אבל תישאר ממתינה לשיבוץ עד
            שהמיכל יהיה בסטטוס מחוטא.
          </div>
        )}

        <div className="brew-modal-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            ביטול
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={
              busy || !selectedTank || !batchNumber || !style
            }
            onClick={() => {
              if (!selectedTank) return;
              void onCreate(selectedTank, {
                batchNumber,
                style,
              });
            }}
          >
            {busy
              ? "יוצר אצווה ו-Sheet..."
              : isSanitized
                ? "צור בישול"
                : "צור והכנס לתור"}
          </button>
        </div>
      </section>
    </div>
  );
}
