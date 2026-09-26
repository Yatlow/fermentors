import { useEffect, useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import { sameStyle } from "../../SERVICES/planning/planningEngine";
import type { BrewRun } from "../../SERVICES/brewing/brewRun";
import { loadSharedBrewingLibrary } from "../../SERVICES/brewing/sharedBrewingLibrary";
import { loadRecipes } from "../../SERVICES/brewing/recipeEditorStore";
import { loadIngredients } from "../../SERVICES/brewing/ingredientEditorStore";
import BrewFormStepper from "../brewing/BrewFormStepper";
import BeerLoader from "../general/Loading";
import "../brewing/BrewingView.css";
import "./DashboardBrewFormModal.css";

type Props = {
  tank: Fermentor;
  onClose: () => void;
};

function extractSpreadsheetId(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : text;
}

function tankType(tankNumber: unknown): "single" | "double" | "triple" {
  const tank = Number(tankNumber);
  if (tank < 5) return "single";
  if (tank < 9) return "double";
  return "triple";
}

function runFromTank(tank: Fermentor): BrewRun | null {
  const batchNumber = String(tank.batchNumber || "").replace("#", "").trim();
  const style = String(tank.beerStyle || "").trim();
  const sheetUrl = String(tank.sheetUrl || "").trim();
  const sheetId = extractSpreadsheetId(sheetUrl);
  if (!batchNumber || !style || !sheetId) return null;

  return {
    batchNumber,
    tankId: tank.id,
    tankNumber: String(tank.tankNumber ?? tank.id),
    tankType: tankType(tank.tankNumber),
    style,
    brewDate: String(tank.brewDate || ""),
    createdAt: new Date(0).toISOString(),
    source: "production",
    started: Number(tank.action) !== 0,
    action: tank.action,
    brewSheetEditRevision: typeof tank.brewSheetEditRevision === "number" ? tank.brewSheetEditRevision : null,
    brewSheetEditRange: typeof tank.brewSheetEditRange === "string" ? tank.brewSheetEditRange : null,
    brewSheetEditValue: typeof tank.brewSheetEditValue === "string" ? tank.brewSheetEditValue : null,
    brewSheetEditOldValue: typeof tank.brewSheetEditOldValue === "string" ? tank.brewSheetEditOldValue : null,
    brewSheetEditSheetName: typeof tank.brewSheetEditSheetName === "string" ? tank.brewSheetEditSheetName : null,
    brewProgress: tank.brewProgress ? {
      blockIndex: tank.brewProgress.blockIndex,
      stageName: tank.brewProgress.stageName,
      stageStartTimeText: tank.brewProgress.stageStartTimeText,
      stageEndTimeText: tank.brewProgress.stageEndTimeText,
    } : null,
    sheetId,
    sheetUrl,
    sheetName: "",
    assignmentStatus: "assigned",
  };
}

export default function DashboardBrewFormModal({ tank, onClose }: Props) {
  const [recipes, setRecipes] = useState(() => loadRecipes());
  const [ingredients, setIngredients] = useState(() => loadIngredients());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const run = useMemo(() => runFromTank(tank), [tank]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSharedBrewingLibrary()
      .then((library) => {
        if (cancelled || !library.hasRemoteLibrary) return;
        setRecipes(library.recipes);
        setIngredients(library.ingredients);
      })
      .catch((err) => {
        console.warn("Failed loading shared brewing library for dashboard brew form", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const recipe = useMemo(() => {
    if (!run) return null;
    return recipes.find((item) => sameStyle(item.style, run.style))
      || recipes.find((item) => item.id.toLowerCase() === run.style.trim().toLowerCase())
      || null;
  }, [recipes, run]);

  useEffect(() => {
    if (!loading && (!run || !recipe)) {
      setError(!run ? "לא ניתן לפתוח את טופס הבישול: חסרים פרטי אצווה או Sheet." : "לא נמצא מתכון תואם לאצווה.");
    } else {
      setError("");
    }
  }, [loading, run, recipe]);

  return (
    <div className="dashboardBrewModalBackdrop" role="presentation" onMouseDown={onClose}>
      <main
        className="dashboardBrewModal brewing-view"
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-label={`טופס בישול מיכל ${tank.tankNumber ?? ""}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {(loading || error) && (
          <button type="button" className="dashboardBrewModalClose" onClick={onClose} aria-label="סגור">×</button>
        )}
        {loading && <BeerLoader overlay message="טוען טופס בישול…" />}
        {!loading && error && <div className="dashboardBrewModalError">{error}</div>}
        {!loading && run && recipe && (
          <BrewFormStepper
            run={run}
            recipe={recipe}
            ingredients={ingredients}
            onClose={onClose}
          />
        )}
      </main>
    </div>
  );
}
