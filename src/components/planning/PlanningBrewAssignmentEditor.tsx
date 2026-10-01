import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getBrewsSummaryPage } from "../../SERVICES/getAndPost/getAllBrews";
import { addDays, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import { brewLitersForSize, brewSizeLabel, type Release } from "../../SERVICES/planning/productionCycle";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import BeerLoader from "../general/Loading";

type BrewPlanWithMeta = BrewPlan;

function tankKind(value: unknown) {
  const n = Number(value);
  if (n >= 2 && n <= 4) return "בודד";
  if (n >= 5 && n <= 8) return "כפול";
  if (n >= 9) return "משולש";
  return "";
}

function styleRank(style: string, promoteSmallSpecials: boolean) {
  const value = style.trim().toLowerCase();
  const hoppyLager = value.includes("הופי") && value.includes("לאגר");
  const lager = value.includes("לאגר") && !hoppyLager;
  const wheat = value.includes("חיטה");
  const stout = value.includes("סטאוט");
  const ipa = /ipa/i.test(value);
  const pale = value.includes("פייל");
  if (lager) return 0;
  if (hoppyLager) return 1;
  if (promoteSmallSpecials && wheat) return 2;
  if (promoteSmallSpecials && stout) return 3;
  if (ipa) return 4;
  if (pale) return 5;
  if (wheat) return 6;
  if (stout) return 7;
  return 8;
}

function normalizeOrder(brews: BrewPlanWithMeta[], sources: Fermentor[], releases: Release[]) {
  const hasLager = brews.some((brew) => brew.style.includes("לאגר"));
  const hasSingleOpportunity = releases.some((release) => {
    const source = sources.find((item) => item.id === release.tankId);
    return !!release.date && tankKind(source?.tankNumber) === "בודד";
  });
  const promoteSmallSpecials = hasLager && hasSingleOpportunity;
  const dates = brews.map((brew) => brew.date).sort();
  return [...brews]
    .sort((a, b) => styleRank(a.style, promoteSmallSpecials) - styleRank(b.style, promoteSmallSpecials))
    .map((brew, index) => ({ ...brew, date: dates[index] ?? brew.date }));
}

function maxBatch(values: unknown[]): number {
  return values.reduce<number>((max, value) => {
    const n = Number(String(value ?? "").replace("#", "").trim());
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
}

function normalizedBatch(value: unknown): string {
  return String(value ?? "").replace("#", "").trim();
}

function sourceForAssignedTank(brew: BrewPlanWithMeta, sources: Fermentor[]) {
  if (!brew.tankId) return undefined;
  return sources.find((item) => item.id === brew.tankId)
    ?? sources.find((item) => String(item.tankNumber) === String(brew.tankId));
}

function canonicalTankId(brew: BrewPlanWithMeta, sources: Fermentor[]): string {
  return sourceForAssignedTank(brew, sources)?.id ?? brew.tankId;
}

function compatibleTankForBrew(brew: BrewPlanWithMeta, tank: Fermentor): boolean {
  return tankKind(tank.tankNumber) === brewSizeLabel(Number(brew.liters) || 0);
}

/**
 * A real ACTION-0 tank is the Firestore reservation created by the brewing
 * flow. Planning may display that identity, but never writes back to the tank.
 * Older fermenting/cold batches are deliberately excluded.
 */
function realNewBrewBatch(brew: BrewPlanWithMeta, sources: Fermentor[]): string {
  const source = sourceForAssignedTank(brew, sources);
  if (!source || Number(source.action) !== 0) return "";
  return normalizedBatch(source.batchNumber);
}

export default function PlanningBrewAssignmentEditor({ initial, allPlans, brews, releases, disabled, onSave, onCancel }: {
  initial: WeekPlan;
  allPlans: WeekPlan[];
  brews: Fermentor[];
  releases: Release[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WeekPlan>(() => {
    const copy = structuredClone(initial);
    // Weekly planning may persist a tentative tank as either the Firestore id or
    // the human tank number. Canonicalize it on first open so the work manager
    // sees the tentative recommendation already selected instead of starting blank.
    copy.brews = copy.brews.map((brew) => {
      const size = brewSizeLabel(Number(brew.liters) || 0);
      return {
        ...brew,
        // Old recommendations could persist the CURRENT beer volume of the
        // suggested tank (1245/3810/etc.) as the future brew volume. Preserve
        // the intended single/double/triple size, but canonicalize liters from
        // style + size before displaying or saving the future cycle.
        liters: brewLitersForSize(brew.style, size),
        ...(brew.tankId ? { tankId: canonicalTankId(brew, brews) } : {}),
      };
    });
    const hasSavedBatchIdentity = copy.brews.some(
      (brew) => normalizedBatch(brew.batchNumber) !== "",
    );
    copy.brews = hasSavedBatchIdentity
      ? copy.brews
      : normalizeOrder(copy.brews as BrewPlanWithMeta[], brews, releases);
    return copy;
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [batchBase, setBatchBase] = useState(() => Math.max(
    maxBatch(brews.map((brew) => brew.batchNumber)),
    maxBatch(allPlans.flatMap((plan) => plan.brews).map((brew) => brew.batchNumber)),
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const weekEnd = addDays(initial.id, 6);

  useEffect(() => {
    let cancelled = false;
    // The editor already has a safe immediate high-water mark from physical
    // tanks + planning. Refresh the single newest historical batch in the
    // background; never block tank assignment while this query is in flight.
    getBrewsSummaryPage(null, 10)
      .then(({ rows: history }) => {
        if (cancelled) return;
        setBatchBase((current) => Math.max(
          current,
          maxBatch(history.map((brew) => brew.batchNumber)),
          maxBatch(brews.map((brew) => brew.batchNumber)),
          maxBatch(allPlans.flatMap((plan) => plan.brews).map((brew) => brew.batchNumber)),
        ));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [brews, allPlans]);

  const orderedBrews = useMemo(() => {
    const current = draft.brews as BrewPlanWithMeta[];
    const preferred = current.map((brew) => realNewBrewBatch(brew, brews) || normalizedBatch(brew.batchNumber));
    const realReservedBatches = new Set(
      brews
        .filter((source) => Number(source.action) === 0)
        .map((source) => Number(normalizedBatch(source.batchNumber)))
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    const used = new Set<number>();
    let next = batchBase + 1;

    return current.map((brew, index) => {
      const preferredNumber = Number(preferred[index]);
      if (Number.isFinite(preferredNumber) && preferredNumber > 0 && !used.has(preferredNumber)) {
        used.add(preferredNumber);
        return { ...brew, batchNumber: String(preferredNumber) };
      }

      while (used.has(next) || realReservedBatches.has(next)) next += 1;
      const batchNumber = String(next);
      used.add(next);
      next += 1;
      return { ...brew, batchNumber };
    });
  }, [draft.brews, batchBase, brews]);
  const selectedBrew = orderedBrews[selectedIndex] ?? null;

  const allWeekTanks = useMemo(() => releases
    .filter((release) => !!release.date && release.date <= weekEnd)
    .map((release) => brews.find((source) => source.id === release.tankId))
    .filter((source): source is Fermentor => !!source && Number(source.tankNumber) !== 1)
    .filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index)
    .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)), [releases, brews, weekEnd]);

  function move(index: number, direction: -1 | 1) {
    const slotBatchNumbers = orderedBrews.map((brew) => brew.batchNumber);
    setDraft((current) => {
      const next = [...(current.brews as BrewPlanWithMeta[])];
      const other = index + direction;
      if (other < 0 || other >= next.length) return current;
      const dates = next.map((brew) => brew.date).sort();
      [next[index], next[other]] = [next[other], next[index]];
      next.forEach((brew, i) => {
        brew.date = dates[i] ?? brew.date;
        brew.batchNumber = slotBatchNumbers[i];
      });
      return { ...current, brews: next };
    });
    setSelectedIndex((current) => Math.max(0, Math.min(orderedBrews.length - 1, current + direction)));
  }

  function setTank(index: number, tankId: string) {
    const selectedForGuard = orderedBrews[index];
    const targetTank = brews.find((item) => item.id === tankId);
    if (!selectedForGuard || !targetTank || !compatibleTankForBrew(selectedForGuard, targetTank)) {
      const required = selectedForGuard ? brewSizeLabel(Number(selectedForGuard.liters) || 0) : "";
      setError(required ? `בישול ${required} ניתן לשבץ רק למיכל ${required}.` : "המיכל אינו תואם לגודל הבישול.");
      return;
    }

    const previousSource = selectedForGuard.tankId
      ? sourceForAssignedTank(selectedForGuard, brews)
      : undefined;
    const otherIndexForGuard = orderedBrews.findIndex((brew, i) => i !== index && canonicalTankId(brew, brews) === tankId);
    if (otherIndexForGuard >= 0 && previousSource) {
      const other = orderedBrews[otherIndexForGuard];
      if (!compatibleTankForBrew(other, previousSource)) {
        const required = brewSizeLabel(Number(other.liters) || 0);
        setError(`לא ניתן להחליף: אצווה ${other.batchNumber} היא בישול ${required} ומיכל ${previousSource.tankNumber} אינו ${required}.`);
        return;
      }
    }

    const targetRelease = releases.find((item) => item.tankId === tankId);
    setDraft((current) => {
      const next = [...(current.brews as BrewPlanWithMeta[])];
      const selected = next[index];
      if (!selected) return current;

      const previousTankId = selected.tankId ? canonicalTankId(selected, brews) : "";
      const otherIndex = next.findIndex((brew, i) => i !== index && canonicalTankId(brew, brews) === tankId);
      const previousRelease = previousTankId ? releases.find((item) => item.tankId === previousTankId) : undefined;

      next[index] = {
        ...selected,
        tankId,
        date: targetRelease?.date && targetRelease.date > selected.date ? targetRelease.date : selected.date,
        tankAssignmentStatus: "confirmed" as const,
      };

      if (otherIndex >= 0) {
        const other = next[otherIndex];
        next[otherIndex] = {
          ...other,
          tankId: previousTankId,
          date: previousTankId && previousRelease?.date && previousRelease.date > other.date ? previousRelease.date : other.date,
          tankAssignmentStatus: previousTankId ? "confirmed" as const : other.tankAssignmentStatus,
        };
      }

      return { ...current, brews: next };
    });
    setError("");
  }

  async function save() {
    if (orderedBrews.some((brew) => !brew.tankId)) {
      setError("יש לשבץ מיכל לכל בישול לפני השמירה.");
      return;
    }
    const incompatible = orderedBrews.find((brew) => {
      const source = sourceForAssignedTank(brew, brews);
      return !source || !compatibleTankForBrew(brew, source);
    });
    if (incompatible) {
      const required = brewSizeLabel(Number(incompatible.liters) || 0);
      setError(`אצווה ${incompatible.batchNumber}: בישול ${required} חייב להיות משובץ למיכל ${required}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...draft,
        brews: orderedBrews.map((brew) => ({ ...brew, tankAssignmentStatus: "confirmed" as const })) as BrewPlan[],
        changeReason: "אישור סדר ושיבוץ בישולים",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "שמירת שיבוצי הבישול נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bp-editor bp-brew-assignment-editor">
      <div className="bp-editor-header">
        <div><h3>סדר ושיבוץ בישולים</h3><small>בחר אצווה, הזז אותה ימינה/שמאלה, ואז בחר מיכל. אם המיכל כבר משובץ לבישול אחר — שתי האצוות יחליפו מיכלים.</small></div>
        <button type="button" onClick={onCancel}>סגירה</button>
      </div>
      {busy && <BeerLoader overlay message="שומר שיבוצי בישול…" />}

      <fieldset disabled={disabled || busy} className="bp-fieldset bp-editor-body bp-brew-visual-editor">
        {orderedBrews.length === 0 && <p className="bp-muted">לא נקבעו בישולים לשבוע הזה.</p>}

        <div className="bp-brew-queue bp-brew-queue-compact" aria-label="סדר הבישולים">
          {orderedBrews.map((brew, index) => {
            const source = sourceForAssignedTank(brew, brews);
            return <article key={brew.id} className={`bp-brew-queue-card bp-brew-queue-card-compact ${index === selectedIndex ? "is-selected" : ""}`} onClick={() => setSelectedIndex(index)}>
              <button type="button" className="bp-brew-arrow" aria-label="העבר ימינה" title="העבר ימינה" disabled={index === 0} onClick={(event) => { event.stopPropagation(); move(index, -1); }}>→</button>
              <button type="button" className="bp-brew-queue-main" onClick={() => setSelectedIndex(index)}>
                <strong>{displayStyle(brew.style)}</strong>
                <small>#{brew.batchNumber}</small>
                <span>{source ? `מיכל ${source.tankNumber}` : "ללא מיכל"}</span>
              </button>
              <button type="button" className="bp-brew-arrow" aria-label="העבר שמאלה" title="העבר שמאלה" disabled={index === orderedBrews.length - 1} onClick={(event) => { event.stopPropagation(); move(index, 1); }}>←</button>
            </article>;
          })}
        </div>

        {selectedBrew && <div className="bp-brew-tank-placement bp-brew-tank-placement-compact">
          <div className="bp-brew-placement-title">
            <b>אצווה {selectedBrew.batchNumber} · {displayStyle(selectedBrew.style)} · {brewSizeLabel(Number(selectedBrew.liters) || 0)}</b>
            <small>כל המיכלים שצפויים להיות פנויים במהלך השבוע מוצגים כאן. ניתן לבחור רק מיכל בגודל {brewSizeLabel(Number(selectedBrew.liters) || 0)}.</small>
          </div>
          <div className="bp-brew-tank-yard bp-brew-tank-row">
            {allWeekTanks.map((tank) => {
              const compatible = compatibleTankForBrew(selectedBrew, tank);
              const selectedTankId = canonicalTankId(selectedBrew, brews);
              const isAssigned = selectedTankId === tank.id;
              const assignedTo = orderedBrews.findIndex((brew) => canonicalTankId(brew, brews) === tank.id);
              const occupiedByOther = assignedTo >= 0 && assignedTo !== selectedIndex;
              const requiredKind = brewSizeLabel(Number(selectedBrew.liters) || 0);
              return <button
                type="button"
                key={tank.id}
                className={`bp-brew-tank-visual bp-brew-tank-visual-compact ${isAssigned ? "is-assigned" : ""}`}
                onClick={() => setTank(selectedIndex, tank.id)}
                disabled={!compatible}
                aria-disabled={!compatible}
                title={!compatible
                  ? `בישול ${requiredKind} ניתן לשבץ רק למיכל ${requiredKind}`
                  : occupiedByOther
                    ? `החלף עם אצווה ${orderedBrews[assignedTo]?.batchNumber}`
                    : `שבץ למיכל ${tank.tankNumber}`}
              >
                <span className="bp-brew-tank-body"><b>{tank.tankNumber}</b><small>{tankKind(tank.tankNumber)}</small></span>
                <span className="bp-brew-tank-cone" />
                <small
                  className="bp-brew-tank-assigned-hint"
                  aria-hidden={!occupiedByOther}
                  style={{ visibility: occupiedByOther ? "visible" : "hidden", minHeight: "1em" }}
                >
                  {occupiedByOther ? `אצווה ${orderedBrews[assignedTo]?.batchNumber}` : "אצווה 0000"}
                </small>
              </button>;
            })}
            {!allWeekTanks.length && <p className="bp-muted">אין מיכלים פנויים בשבוע הזה.</p>}
          </div>
        </div>}

        {error && <p role="alert" className="bp-alert">{error}</p>}
        <div className="bp-actions"><button type="button" onClick={save} disabled={orderedBrews.length === 0}>אישור סדר ושיבוץ</button><button type="button" onClick={onCancel}>ביטול</button></div>
      </fieldset>
    </section>
  );
}
