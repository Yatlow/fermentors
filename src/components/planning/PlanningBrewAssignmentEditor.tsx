import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getAllBrewsSummary } from "../../SERVICES/getAndPost/getAllBrews";
import { addDays, parseDate, sameStyle, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import type { Release } from "../../SERVICES/planning/productionCycle";
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
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
}

export default function PlanningBrewAssignmentEditor({ initial, brews, releases, disabled, onSave, onCancel }: {
  initial: WeekPlan;
  brews: Fermentor[];
  releases: Release[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<WeekPlan>(() => {
    const copy = structuredClone(initial);
    const hasSavedBatchIdentity = copy.brews.some(
      (brew) => String(brew.batchNumber || "").trim() !== "",
    );
    copy.brews = hasSavedBatchIdentity
      ? copy.brews
      : normalizeOrder(
          copy.brews as BrewPlanWithMeta[],
          brews,
          releases,
        );
    return copy;
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [batchBase, setBatchBase] = useState(() => maxBatch(brews.map((brew) => brew.batchNumber)));
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const weekEnd = addDays(initial.id, 6);

  useEffect(() => {
    let cancelled = false;
    getAllBrewsSummary()
      .then((history) => {
        if (cancelled) return;
        setBatchBase(Math.max(maxBatch(history.map((brew) => brew.batchNumber)), maxBatch(brews.map((brew) => brew.batchNumber))));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoadingBatches(false); });
    return () => { cancelled = true; };
  }, [brews]);

  const orderedBrews = useMemo(() => {
    const current = draft.brews as BrewPlanWithMeta[];
    const actualByPlanId = new Map<string, string>();

    current.forEach((brew) => {
      const source = brews.find((item) => item.id === brew.tankId);
      if (!source?.batchNumber || !source.beerStyle) return;

      const brewed = parseDate(source.brewDate);
      const isCurrentWeekBatch =
        Number(source.action) === 0 ||
        (!!brewed && brewed >= initial.id && brewed <= weekEnd);

      if (
        isCurrentWeekBatch &&
        sameStyle(source.beerStyle, brew.style)
      ) {
        actualByPlanId.set(brew.id, String(source.batchNumber));
      }
    });

    const reserved = new Set<number>();
    current.forEach((brew) => {
      const actual = actualByPlanId.get(brew.id);
      const value = Number(actual || brew.batchNumber);
      if (Number.isFinite(value) && value > 0) reserved.add(value);
    });

    let next = Math.max(
      batchBase,
      ...Array.from(reserved.values()),
    ) + 1;

    return current.map((brew) => {
      const actual = actualByPlanId.get(brew.id);
      if (actual) return { ...brew, batchNumber: actual };

      const existing = String(brew.batchNumber || "").trim();
      if (existing) return { ...brew, batchNumber: existing };

      while (reserved.has(next)) next += 1;
      const batchNumber = String(next);
      reserved.add(next);
      next += 1;
      return { ...brew, batchNumber };
    });
  }, [draft.brews, batchBase, brews, initial.id, weekEnd]);
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
    const targetRelease = releases.find((item) => item.tankId === tankId);
    setDraft((current) => {
      const next = [...(current.brews as BrewPlanWithMeta[])];
      const selected = next[index];
      if (!selected) return current;

      const previousTankId = selected.tankId;
      const otherIndex = next.findIndex((brew, i) => i !== index && brew.tankId === tankId);
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
      {(busy || loadingBatches) && <BeerLoader overlay message={busy ? "שומר שיבוצי בישול…" : "טוען מספר אצווה אחרון…"} />}

      <fieldset disabled={disabled || busy || loadingBatches} className="bp-fieldset bp-editor-body bp-brew-visual-editor">
        {orderedBrews.length === 0 && <p className="bp-muted">לא נקבעו בישולים לשבוע הזה.</p>}

        <div className="bp-brew-queue bp-brew-queue-compact" aria-label="סדר הבישולים">
          {orderedBrews.map((brew, index) => {
            const source = brews.find((item) => item.id === brew.tankId);
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
            <b>אצווה {selectedBrew.batchNumber} · {displayStyle(selectedBrew.style)}</b>
            <small>כל המיכלים שצפויים להיות פנויים במהלך השבוע מוצגים כאן, גם אם כרגע שובצו לאצווה אחרת.</small>
          </div>
          <div className="bp-brew-tank-yard bp-brew-tank-row">
            {allWeekTanks.map((tank) => {
              const isAssigned = selectedBrew.tankId === tank.id;
              const assignedTo = orderedBrews.findIndex((brew) => brew.tankId === tank.id);
              const occupiedByOther = assignedTo >= 0 && assignedTo !== selectedIndex;
              return <button
                type="button"
                key={tank.id}
                className={`bp-brew-tank-visual bp-brew-tank-visual-compact ${isAssigned ? "is-assigned" : ""}`}
                onClick={() => setTank(selectedIndex, tank.id)}
                title={occupiedByOther ? `החלף עם אצווה ${orderedBrews[assignedTo]?.batchNumber}` : `שבץ למיכל ${tank.tankNumber}`}
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
