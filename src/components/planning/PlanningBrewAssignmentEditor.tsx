import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
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

function assignAvailableTanks(brews: BrewPlanWithMeta[], sources: Fermentor[], releases: Release[], weekEnd: string): BrewPlan[] {
  const available = releases
    .flatMap((release) => release.date && release.date <= weekEnd ? [{ release: { ...release, date: release.date }, tank: sources.find((source) => source.id === release.tankId) }] : [])
    .filter((entry): entry is { release: Release & { date: string }; tank: Fermentor } => !!entry.tank && Number(entry.tank.tankNumber) !== 1)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.tank.id === entry.tank.id) === index)
    .sort((a, b) => a.release.date.localeCompare(b.release.date) || Number(a.tank.tankNumber) - Number(b.tank.tankNumber));
  const used = new Set<string>();
  return brews.map((brew): BrewPlan => {
    const match = available.find(({ tank }) => !used.has(tank.id) && compatibleTankForBrew(brew, tank));
    if (!match) return { ...brew, tankId: "" };
    used.add(match.tank.id);
    return {
      ...brew,
      tankId: match.tank.id,
      date: match.release.date > brew.date ? match.release.date : brew.date,
      tankAssignmentStatus: "tentative",
      availabilityOverride: false,
    };
  });
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

export default function PlanningBrewAssignmentEditor({ initial, brews, releases, exceptionReleases, disabled, onSave, onCancel }: {
  initial: WeekPlan;
  allPlans: WeekPlan[];
  brews: Fermentor[];
  releases: Release[];
  exceptionReleases?: Release[];
  disabled: boolean;
  onSave: (plan: WeekPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const weekEnd = addDays(initial.id, 6);
  const [draft, setDraft] = useState<WeekPlan>(() => {
    const copy = structuredClone(initial);
    copy.brews = copy.brews.map((brew) => {
      const size = brewSizeLabel(Number(brew.liters) || 0);
      return {
        ...brew,
        liters: brewLitersForSize(brew.style, size),
        ...(brew.tankId ? { tankId: canonicalTankId(brew, brews) } : {}),
      };
    });
    const hasSavedBatchIdentity = copy.brews.some(
      (brew) => normalizedBatch(brew.batchNumber) !== "",
    );
    if (!hasSavedBatchIdentity) {
      const ordered = normalizeOrder(copy.brews as BrewPlanWithMeta[], brews, releases);
      copy.brews = assignAvailableTanks(ordered, brews, releases, weekEnd);
    }
    return copy;
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showUnavailableTanks, setShowUnavailableTanks] = useState(false);
  const [pendingOverrideTankId, setPendingOverrideTankId] = useState<string | null>(null);

  const assignedTankIds = useMemo(() => new Set(draft.brews.map((brew) => canonicalTankId(brew, brews)).filter(Boolean)), [draft.brews, brews]);
  const selected = draft.brews[selectedIndex] as BrewPlanWithMeta | undefined;
  const candidateReleases = useMemo(() => {
    if (!selected) return [];
    const pool = showUnavailableTanks ? [...releases, ...(exceptionReleases ?? [])] : releases;
    return pool.filter((release, index, all) => {
      const source = brews.find((item) => item.id === release.tankId);
      if (!source || !compatibleTankForBrew(selected, source)) return false;
      if (assignedTankIds.has(source.id) && canonicalTankId(selected, brews) !== source.id) return false;
      return all.findIndex((candidate) => candidate.tankId === release.tankId) === index;
    });
  }, [selected, showUnavailableTanks, releases, exceptionReleases, brews, assignedTankIds]);

  const selectTank = (tankId: string) => {
    if (!selected) return;
    const isAvailable = releases.some((release) => release.tankId === tankId);
    if (!isAvailable && !showUnavailableTanks) return;
    if (!isAvailable) {
      setPendingOverrideTankId(tankId);
      return;
    }
    setDraft((current) => ({
      ...current,
      brews: current.brews.map((brew, index) => index === selectedIndex ? {
        ...brew,
        tankId,
        tankAssignmentStatus: "tentative",
        availabilityOverride: false,
      } : brew),
    }));
  };

  const confirmOverride = () => {
    if (!pendingOverrideTankId) return;
    const tankId = pendingOverrideTankId;
    setDraft((current) => ({
      ...current,
      brews: current.brews.map((brew, index) => index === selectedIndex ? {
        ...brew,
        tankId,
        tankAssignmentStatus: "tentative",
        availabilityOverride: true,
      } : brew),
    }));
    setPendingOverrideTankId(null);
  };

  const save = async () => {
    setError("");
    const missingTank = draft.brews.find((brew) => !brew.tankId);
    if (missingTank) {
      setError(`אין מיכל משובץ עבור ${displayStyle(missingTank.style)}.`);
      return;
    }
    const duplicate = draft.brews.find((brew, index) => draft.brews.findIndex((other) => canonicalTankId(other, brews) === canonicalTankId(brew, brews)) !== index);
    if (duplicate) {
      setError("אותו מיכל לא יכול להיות משובץ לשני בישולים באותו שבוע.");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        ...draft,
        brews: draft.brews.map((brew) => ({ ...brew, tankId: canonicalTankId(brew, brews) })),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "שמירת שיבוצי הבישול נכשלה.");
    } finally {
      setBusy(false);
    }
  };

  if (!selected) return null;

  return (
    <div className="planning-brew-assignment" dir="rtl">
      {busy && <BeerLoader />}
      <div className="planning-brew-assignment__header">
        <h3>סדר ושיבוץ בישולים</h3>
        <button type="button" onClick={onCancel}>סגור</button>
      </div>
      <div className="planning-brew-assignment__list">
        {draft.brews.map((brew, index) => {
          const source = sourceForAssignedTank(brew, brews);
          return (
            <button key={brew.id} type="button" className={index === selectedIndex ? "active" : ""} onClick={() => setSelectedIndex(index)}>
              <strong>{index + 1}. {displayStyle(brew.style)}</strong>
              <span>{brewSizeLabel(Number(brew.liters) || 0)}</span>
              <span>{source ? `מיכל ${source.tankNumber}` : "ללא מיכל"}</span>
              <span>{brew.date}</span>
            </button>
          );
        })}
      </div>
      <div className="planning-brew-assignment__tanks">
        <h4>מיכלים מתאימים</h4>
        {candidateReleases.map((release) => {
          const source = brews.find((item) => item.id === release.tankId);
          if (!source) return null;
          const active = canonicalTankId(selected, brews) === source.id;
          const isAvailable = releases.some((item) => item.tankId === release.tankId);
          return (
            <button key={release.tankId} type="button" className={active ? "active" : ""} onClick={() => selectTank(source.id)}>
              מיכל {source.tankNumber} · {tankKind(source.tankNumber)}{release.date ? ` · פנוי ${release.date}` : ""}{!isAvailable ? " · חריגה" : ""}
            </button>
          );
        })}
        {!!exceptionReleases?.length && (
          <button type="button" onClick={() => setShowUnavailableTanks((value) => !value)}>
            {showUnavailableTanks ? "הסתר מיכלים לא פנויים" : "הצג גם מיכלים לא פנויים"}
          </button>
        )}
      </div>
      {pendingOverrideTankId && (
        <div className="planning-brew-assignment__override">
          <p>המיכל שבחרת אינו פנוי לפי התכנון. להשתמש בו בכל זאת?</p>
          <button type="button" onClick={confirmOverride}>כן, אשר חריגה</button>
          <button type="button" onClick={() => setPendingOverrideTankId(null)}>ביטול</button>
        </div>
      )}
      {error && <p className="planning-brew-assignment__error">{error}</p>}
      <div className="planning-brew-assignment__actions">
        <button type="button" disabled={disabled || busy} onClick={save}>שמור שיבוצים</button>
      </div>
    </div>
  );
}
