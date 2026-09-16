import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { getAllBrewsSummary } from "../../SERVICES/getAndPost/getAllBrews";
import { addDays, type BrewPlan, type WeekPlan } from "../../SERVICES/planning/planningEngine";
import type { Release } from "../../SERVICES/planning/productionCycle";
import { displayStyle } from "../../SERVICES/planning/planningPresentation";
import BeerLoader from "../general/Loading";

type BrewPlanWithMeta = BrewPlan & {
  batchNumber?: string;
  tankAssignmentStatus?: "tentative" | "confirmed";
};

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
    copy.brews = normalizeOrder(copy.brews as BrewPlanWithMeta[], brews, releases);
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

  const orderedBrews = useMemo(
    () => (draft.brews as BrewPlanWithMeta[]).map((brew, index) => ({ ...brew, batchNumber: String(batchBase + index + 1) })),
    [draft.brews, batchBase],
  );
  const selectedBrew = orderedBrews[selectedIndex] ?? null;

  function move(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const next = [...(current.brews as BrewPlanWithMeta[])];
      const other = index + direction;
      if (other < 0 || other >= next.length) return current;
      const dates = next.map((brew) => brew.date).sort();
      [next[index], next[other]] = [next[other], next[index]];
      next.forEach((brew, i) => { brew.date = dates[i] ?? brew.date; });
      return { ...current, brews: next };
    });
    setSelectedIndex((current) => Math.max(0, Math.min(orderedBrews.length - 1, current + direction)));
  }

  function tankOptions(index: number) {
    const occupied = new Set(orderedBrews.filter((_, otherIndex) => otherIndex !== index).map((other) => other.tankId).filter(Boolean));
    return releases
      .filter((release) => !!release.date && release.date <= weekEnd && !occupied.has(release.tankId))
      .map((release) => brews.find((source) => source.id === release.tankId))
      .filter((source): source is Fermentor => !!source && Number(source.tankNumber) !== 1)
      .filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index)
      .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber));
  }

  function setTank(index: number, tankId: string) {
    const release = releases.find((item) => item.tankId === tankId);
    setDraft((current) => ({
      ...current,
      brews: current.brews.map((brew, i) => i === index ? {
        ...brew,
        tankId,
        date: release?.date && release.date > brew.date ? release.date : brew.date,
        tankAssignmentStatus: "confirmed" as const,
      } : brew),
    }));
  }

  async function save() {
    if (orderedBrews.some((brew) => !brew.tankId)) {
      setError("יש לשבץ מיכל לכל בישול לפני השמירה.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({ ...draft, brews: orderedBrews.map((brew) => ({ ...brew, tankAssignmentStatus: "confirmed" as const })) as BrewPlan[], changeReason: "אישור סדר ושיבוץ בישולים" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "שמירת שיבוצי הבישול נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const availableTanks = selectedBrew ? tankOptions(selectedIndex) : [];

  return (
    <section className="bp-editor bp-brew-assignment-editor">
      <div className="bp-editor-header">
        <div><h3>סדר ושיבוץ בישולים</h3><small>בחר בישול, שנה את הסדר בחיצים, ואז לחץ על מיכל פנוי באותו שבוע.</small></div>
        <button type="button" onClick={onCancel}>סגירה</button>
      </div>
      {(busy || loadingBatches) && <BeerLoader overlay message={busy ? "שומר שיבוצי בישול…" : "טוען מספר אצווה אחרון…"} />}

      <fieldset disabled={disabled || busy || loadingBatches} className="bp-fieldset bp-editor-body bp-brew-visual-editor">
        {orderedBrews.length === 0 && <p className="bp-muted">לא נקבעו בישולים לשבוע הזה.</p>}
        <div className="bp-brew-queue" aria-label="סדר הבישולים">
          {orderedBrews.map((brew, index) => {
            const source = brews.find((item) => item.id === brew.tankId);
            return <article key={brew.id} className={`bp-brew-queue-card ${index === selectedIndex ? "is-selected" : ""}`} onClick={() => setSelectedIndex(index)}>
              <div className="bp-brew-order-number">{index + 1}</div>
              <button type="button" className="bp-brew-queue-main" onClick={() => setSelectedIndex(index)}><strong>{displayStyle(brew.style)}</strong><small>אצווה {brew.batchNumber}</small><span>{source ? `מיכל ${source.tankNumber}` : "טרם שובץ"}</span></button>
              <div className="bp-brew-order-actions">
                <button type="button" aria-label="העבר בישול קודם" title="העבר קודם" disabled={index === 0} onClick={(event) => { event.stopPropagation(); move(index, -1); }}>↑</button>
                <button type="button" aria-label="העבר בישול אחר כך" title="העבר אחר כך" disabled={index === orderedBrews.length - 1} onClick={(event) => { event.stopPropagation(); move(index, 1); }}>↓</button>
              </div>
            </article>;
          })}
        </div>

        {selectedBrew && <div className="bp-brew-tank-placement">
          <div className="bp-brew-placement-title"><b>שיבוץ {displayStyle(selectedBrew.style)} · אצווה {selectedBrew.batchNumber}</b><small>מוצגים רק מיכלים שצפויים להיות פנויים במהלך השבוע.</small></div>
          <div className="bp-brew-tank-yard">
            {availableTanks.map((tank) => {
              const isAssigned = selectedBrew.tankId === tank.id;
              return <button type="button" key={tank.id} className={`bp-brew-tank-visual ${isAssigned ? "is-assigned" : ""}`} onClick={() => setTank(selectedIndex, tank.id)} title={`שבץ למיכל ${tank.tankNumber}`}>
                <span className="bp-brew-tank-body"><b>{tank.tankNumber}</b><small>{tankKind(tank.tankNumber)}</small></span><span className="bp-brew-tank-cone" />
              </button>;
            })}
            {!availableTanks.length && <p className="bp-muted">אין מיכל פנוי מתאים בשבוע הזה.</p>}
          </div>
        </div>}

        {error && <p role="alert" className="bp-alert">{error}</p>}
        <div className="bp-actions"><button type="button" onClick={save} disabled={orderedBrews.length === 0}>אישור סדר ושיבוץ</button><button type="button" onClick={onCancel}>ביטול</button></div>
      </fieldset>
    </section>
  );
}
