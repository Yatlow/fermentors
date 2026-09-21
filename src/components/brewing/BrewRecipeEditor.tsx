import { useMemo, useState } from "react";
import type {
  BrewHopPurpose,
  BrewRecipe,
  BrewRecipeHop,
  BrewRecipeMashStep,
} from "../../SERVICES/brewing/brewRecipe";
import type { IngredientDefinition } from "../../SERVICES/brewing/ingredientLibrary";

type Props = {
  recipe: BrewRecipe;
  ingredients: IngredientDefinition[];
  onSave: (recipe: BrewRecipe) => void;
  onBack: () => void;
};

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function BrewRecipeEditor({
  recipe: initialRecipe,
  ingredients,
  onSave,
  onBack,
}: Props) {
  const [recipe, setRecipe] = useState<BrewRecipe>(() =>
    JSON.parse(JSON.stringify(initialRecipe)) as BrewRecipe,
  );

  const grainOptions = useMemo(
    () => ingredients.filter((item) => item.category === "grain"),
    [ingredients],
  );
  const hopOptions = useMemo(
    () => ingredients.filter((item) => item.category === "hop"),
    [ingredients],
  );
  const yeastOptions = useMemo(
    () => ingredients.filter((item) => item.category === "yeast"),
    [ingredients],
  );

  function updateMashStep(index: number, patch: Partial<BrewRecipeMashStep>) {
    setRecipe((current) => ({
      ...current,
      mash: {
        ...current.mash,
        steps: current.mash.steps.map((step, i) =>
          i === index ? { ...step, ...patch } : step,
        ),
      },
    }));
  }

  function updateHop(id: string, patch: Partial<BrewRecipeHop>) {
    setRecipe((current) => ({
      ...current,
      hops: current.hops.map((hop) => (hop.id === id ? { ...hop, ...patch } : hop)),
    }));
  }

  function addGrain() {
    const ingredientId = grainOptions[0]?.id || "";
    setRecipe((current) => ({
      ...current,
      grains: [...current.grains, { ingredientId, kgPerBrew: 0 }],
    }));
  }

  const mashIn = recipe.mash.steps[0];
  const mashOut = recipe.mash.steps[recipe.mash.steps.length - 1];
  const middleMashSteps = recipe.mash.steps.slice(1, -1);

  function addMashStep() {
    const step: BrewRecipeMashStep = {
      id: `mash-step-${Date.now()}`,
      label: `מנוחה ${Math.max(1, middleMashSteps.length + 1)}`,
      targetTemp: 0,
      minutes: 0,
    };
    setRecipe((current) => ({
      ...current,
      mash: {
        ...current.mash,
        steps: [
          current.mash.steps[0],
          ...current.mash.steps.slice(1, -1),
          step,
          current.mash.steps[current.mash.steps.length - 1],
        ],
      },
    }));
  }

  function removeMashStep(id: string) {
    setRecipe((current) => ({
      ...current,
      mash: {
        ...current.mash,
        steps: current.mash.steps.filter((step) => step.id !== id),
      },
    }));
  }

  function moveMashStep(id: string, direction: -1 | 1) {
    setRecipe((current) => {
      const first = current.mash.steps[0];
      const last = current.mash.steps[current.mash.steps.length - 1];
      const middle = current.mash.steps.slice(1, -1);
      const index = middle.findIndex((step) => step.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= middle.length) return current;
      const nextMiddle = [...middle];
      [nextMiddle[index], nextMiddle[target]] = [nextMiddle[target], nextMiddle[index]];
      return {
        ...current,
        mash: { ...current.mash, steps: [first, ...nextMiddle, last] },
      };
    });
  }

  function addHop() {
    const ingredientId = hopOptions[0]?.id || "";
    setRecipe((current) => ({
      ...current,
      hops: [
        ...current.hops,
        {
          id: `hop-${Date.now()}`,
          ingredientId,
          purpose: "aroma",
          gramsPerLiter: 0,
        },
      ],
    }));
  }

  return (
    <section className="brew-recipe-editor">
      <div className="brewing-panel-heading">
        <div>
          <button type="button" className="brew-back-button" onClick={onBack}>
            חזרה לספריית המתכונים
          </button>
          <h2>עריכת {recipe.style}</h2>
          <p>
            המתכון מכיל רק את הוראות המתכון. ספקים, lots ו-AA נוכחי מנוהלים בספריית חומרי הגלם.
          </p>
        </div>
        <span className="brewing-count">v{recipe.version}</span>
      </div>

      <section className="brew-editor-section">
        <h3>פרטי מתכון</h3>
        <div className="brew-editor-two-cols">
          <label>
            שם / סגנון
            <input
              value={recipe.style}
              onChange={(e) =>
                setRecipe((current) => ({ ...current, style: e.target.value }))
              }
            />
          </label>
          <label>
            מי מאש, ליטר
            <input
              type="number"
              value={recipe.mash.waterLiters}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  mash: { ...current.mash, waterLiters: numberValue(e.target.value) },
                }))
              }
            />
          </label>
          <label>
            סוף רתיחה °P
            <input
              type="number"
              step="0.01"
              value={recipe.targets.endBoilPlato}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  targets: {
                    ...current.targets,
                    endBoilPlato: numberValue(e.target.value),
                  },
                }))
              }
            />
          </label>
          <label>
            תחילת תסיסה יעד °P
            <input
              type="number"
              step="0.01"
              value={recipe.targets.startingPlato}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  targets: {
                    ...current.targets,
                    startingPlato: numberValue(e.target.value),
                  },
                }))
              }
            />
          </label>
        </div>
      </section>

      <section className="brew-editor-section">
        <div className="brew-section-title">
          <h3>לתת וחומרי מאש</h3>
          <button type="button" onClick={addGrain}>+ חומר</button>
        </div>
        <div className="brew-editor-table">
          {recipe.grains.map((grain, index) => (
            <div className="brew-editor-row brew-editor-row-grain" key={`${grain.ingredientId}-${index}`}>
              <label>
                חומר גלם
                <select
                  value={grain.ingredientId}
                  onChange={(e) =>
                    setRecipe((current) => ({
                      ...current,
                      grains: current.grains.map((item, i) =>
                        i === index ? { ...item, ingredientId: e.target.value } : item,
                      ),
                    }))
                  }
                >
                  {grainOptions.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                ק"ג לבישול
                <input
                  type="number"
                  step="0.1"
                  value={grain.kgPerBrew}
                  onChange={(e) =>
                    setRecipe((current) => ({
                      ...current,
                      grains: current.grains.map((item, i) =>
                        i === index
                          ? { ...item, kgPerBrew: numberValue(e.target.value) }
                          : item,
                      ),
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="brewing-danger-button"
                onClick={() =>
                  setRecipe((current) => ({
                    ...current,
                    grains: current.grains.filter((_, i) => i !== index),
                  }))
                }
              >
                הסר
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="brew-editor-section">
        <h3>תהליך מאש</h3>
        <div className="brew-editor-table">
          {recipe.mash.steps.map((step, index) => (
            <div className="brew-editor-row brew-editor-row-mash" key={step.id}>
              <label>
                שלב
                <input
                  value={step.label}
                  onChange={(e) => updateMashStep(index, { label: e.target.value })}
                />
              </label>
              <label>
                יעד °C
                <input
                  type="number"
                  step="0.1"
                  value={step.targetTemp}
                  onChange={(e) =>
                    updateMashStep(index, { targetTemp: numberValue(e.target.value) })
                  }
                />
              </label>
              <label>
                דקות
                <input
                  type="number"
                  value={step.minutes ?? ""}
                  onChange={(e) =>
                    updateMashStep(index, {
                      minutes:
                        e.target.value === "" ? undefined : numberValue(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="brew-editor-section">
        <div className="brew-section-title">
          <h3>כשות</h3>
          <div className="brew-inline-actions">
            <button type="button" onClick={() => addHop("boil")}>+ רתיחה</button>
            <button type="button" onClick={() => addHop("dryHop")}>+ דרייהופ</button>
          </div>
        </div>
        <div className="brew-editor-table">
          {recipe.hops.map((hop) => (
            <div className="brew-editor-row brew-editor-row-hop" key={hop.id}>
              <label>
                חומר גלם
                <select
                  value={hop.ingredientId}
                  onChange={(e) => updateHop(hop.id, { ingredientId: e.target.value })}
                >
                  {hopOptions.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                שלב
                <select
                  value={hop.phase}
                  onChange={(e) =>
                    updateHop(hop.id, {
                      phase: e.target.value as BrewRecipeHop["phase"],
                    })
                  }
                >
                  <option value="boil">רתיחה</option>
                  <option value="flameout">Flame out</option>
                  <option value="dryHop">דרייהופ</option>
                </select>
              </label>
              <label>
                גרם/ליטר
                <input
                  type="number"
                  step="0.001"
                  value={hop.gramsPerLiter}
                  onChange={(e) =>
                    updateHop(hop.id, { gramsPerLiter: numberValue(e.target.value) })
                  }
                />
              </label>
              <label>
                AA ייחוס %
                <input
                  type="number"
                  step="0.1"
                  value={hop.referenceAlpha ?? ""}
                  onChange={(e) =>
                    updateHop(hop.id, {
                      referenceAlpha:
                        e.target.value === "" ? undefined : numberValue(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                {hop.phase === "dryHop" ? "ימים מהבישול" : "דקות לסוף"}
                <input
                  type="number"
                  value={
                    hop.phase === "dryHop"
                      ? hop.daysAfterBrew ?? ""
                      : hop.minutesFromEnd ?? ""
                  }
                  onChange={(e) =>
                    hop.phase === "dryHop"
                      ? updateHop(hop.id, { daysAfterBrew: numberValue(e.target.value) })
                      : updateHop(hop.id, { minutesFromEnd: numberValue(e.target.value) })
                  }
                />
              </label>
              <button
                type="button"
                className="brewing-danger-button"
                onClick={() =>
                  setRecipe((current) => ({
                    ...current,
                    hops: current.hops.filter((item) => item.id !== hop.id),
                  }))
                }
              >
                הסר
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="brew-editor-section">
        <h3>שמרים ותסיסה</h3>
        <div className="brew-editor-two-cols">
          <label>
            שמרים
            <select
              value={recipe.yeast.ingredientId}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  yeast: { ...current.yeast, ingredientId: e.target.value },
                }))
              }
            >
              <option value="">בחר</option>
              {yeastOptions.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label>
            גרם לכל בישול
            <input
              type="number"
              value={recipe.yeast.gramsPerBrew}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  yeast: {
                    ...current.yeast,
                    gramsPerBrew: numberValue(e.target.value),
                  },
                }))
              }
            />
          </label>
          <label>
            תוספת גרם לאצווה
            <input
              type="number"
              value={recipe.yeast.extraPerBatch}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  yeast: {
                    ...current.yeast,
                    extraPerBatch: numberValue(e.target.value),
                  },
                }))
              }
            />
          </label>
          <label>
            טמפ' תסיסה °C
            <input
              type="number"
              step="0.1"
              value={recipe.fermentationTemp}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  fermentationTemp: numberValue(e.target.value),
                }))
              }
            />
          </label>
        </div>
      </section>

      <div className="brew-editor-actions">
        <button type="button" className="btn-primary" onClick={() => onSave(recipe)}>
          שמור מתכון
        </button>
        <button type="button" onClick={onBack}>ביטול</button>
      </div>
    </section>
  );
}
