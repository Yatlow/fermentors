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

  function updateMashStep(id: string, patch: Partial<BrewRecipeMashStep>) {
    setRecipe((current) => ({
      ...current,
      mash: {
        ...current.mash,
        steps: current.mash.steps.map((step) =>
          step.id === id ? { ...step, ...patch } : step,
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
  const mashPairs = Array.from(
    { length: Math.ceil(middleMashSteps.length / 2) },
    (_, index) => ({
      rest: middleMashSteps[index * 2],
      heat: middleMashSteps[index * 2 + 1],
    }),
  ).filter((pair) => !!pair.rest);

  function renumberMashMiddle(steps: BrewRecipeMashStep[]) {
    return steps.map((step, index) => {
      const pairNumber = Math.floor(index / 2) + 1;
      const isRest = index % 2 === 0;
      return {
        ...step,
        id: `${isRest ? "rest" : "heat"}${pairNumber}`,
        label: `${isRest ? "מנוחה" : "חימום"} ${pairNumber}`,
        minutes: isRest ? step.minutes : undefined,
      };
    });
  }

  function addMashStep() {
    setRecipe((current) => {
      const first = current.mash.steps[0];
      const last = current.mash.steps[current.mash.steps.length - 1];
      const middle = current.mash.steps.slice(1, -1);
      const pairNumber = Math.floor(middle.length / 2) + 1;
      const rest: BrewRecipeMashStep = {
        id: `rest${pairNumber}`,
        label: `מנוחה ${pairNumber}`,
        targetTemp: 0,
        minutes: 0,
      };
      const heat: BrewRecipeMashStep = {
        id: `heat${pairNumber}`,
        label: `חימום ${pairNumber}`,
        targetTemp: last?.targetTemp ?? 78,
      };
      return {
        ...current,
        mash: {
          ...current.mash,
          steps: [first, ...middle, rest, heat, last],
        },
      };
    });
  }

  function removeMashPair(index: number) {
    setRecipe((current) => {
      const first = current.mash.steps[0];
      const last = current.mash.steps[current.mash.steps.length - 1];
      const middle = current.mash.steps.slice(1, -1);
      const nextMiddle = middle.filter(
        (_, stepIndex) =>
          stepIndex !== index * 2 &&
          stepIndex !== index * 2 + 1,
      );
      return {
        ...current,
        mash: {
          ...current.mash,
          steps: [first, ...renumberMashMiddle(nextMiddle), last],
        },
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
          <h3>לתת</h3>
          <button
            type="button"
            className="brew-action-button brew-action-button-add"
            onClick={addGrain}
          >
            + לתת
          </button>
        </div>
        <div className="brew-editor-table">
          {recipe.grains.map((grain, index) => (
            <div className="brew-editor-row brew-editor-row-grain" key={`${grain.ingredientId}-${index}`}>
              <label>
                לתת
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
                className="brew-icon-button brew-icon-button-danger"
                aria-label="הסר לתת"
                title="הסר לתת"
                onClick={() =>
                  setRecipe((current) => ({
                    ...current,
                    grains: current.grains.filter((_, i) => i !== index),
                  }))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="brew-editor-section">
        <div className="brew-section-title">
          <h3>תהליך מאש</h3>
          <button
            type="button"
            className="brew-action-button brew-action-button-add"
            onClick={addMashStep}
          >
            + מנוחה וחימום
          </button>
        </div>

        {mashIn && (
          <div className="brew-editor-row brew-editor-row-mash-fixed">
            <div className="brew-mash-boundary-label">
              <strong>מאש אין</strong>
              <span>שלב ראשון קבוע</span>
            </div>
            <label>
              טמפ׳ °C
              <input
                type="number"
                step="0.1"
                value={mashIn.targetTemp}
                onChange={(e) =>
                  updateMashStep("mashIn", {
                    targetTemp: numberValue(e.target.value),
                  })
                }
              />
            </label>
            <label>
              מים, ליטר
              <input
                type="number"
                step="1"
                value={recipe.mash.waterLiters}
                onChange={(e) =>
                  setRecipe((current) => ({
                    ...current,
                    mash: {
                      ...current.mash,
                      waterLiters: numberValue(e.target.value),
                    },
                  }))
                }
              />
            </label>
          </div>
        )}

        <div className="brew-editor-table brew-mash-middle-list">
          {mashPairs.map((pair, index) => (
            <div className="brew-mash-pair" key={pair.rest.id}>
              <div className="brew-editor-row brew-editor-row-mash">
                <div className="brew-mash-step-name">
                  <strong>מנוחה {index + 1}</strong>
                </div>
                <label>
                  יעד °C
                  <input
                    type="number"
                    step="0.1"
                    value={pair.rest.targetTemp}
                    onChange={(e) =>
                      updateMashStep(pair.rest.id, {
                        targetTemp: numberValue(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  דקות
                  <input
                    type="number"
                    value={pair.rest.minutes ?? ""}
                    onChange={(e) =>
                      updateMashStep(pair.rest.id, {
                        minutes:
                          e.target.value === ""
                            ? undefined
                            : numberValue(e.target.value),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="brew-icon-button brew-icon-button-danger"
                  aria-label={`הסר מנוחה וחימום ${index + 1}`}
                  title="הסר מנוחה וחימום"
                  onClick={() => removeMashPair(index)}
                >
                  ×
                </button>
              </div>

              {pair.heat && (
                <div className="brew-editor-row brew-editor-row-mash brew-editor-row-heat">
                  <div className="brew-mash-step-name">
                    <strong>חימום {index + 1}</strong>
                    <span>ללא משך מוגדר</span>
                  </div>
                  <label>
                    יעד °C
                    <input
                      type="number"
                      step="0.1"
                      value={pair.heat.targetTemp}
                      onChange={(e) =>
                        updateMashStep(pair.heat.id, {
                          targetTemp: numberValue(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
        {mashOut && (
          <div className="brew-editor-row brew-editor-row-mash-fixed">
            <div className="brew-mash-boundary-label">
              <strong>מאש אווט</strong>
              <span>שלב אחרון קבוע</span>
            </div>
            <label>
              טמפ׳ °C
              <input
                type="number"
                step="0.1"
                value={mashOut.targetTemp}
                onChange={(e) =>
                  updateMashStep("mashOut", {
                    targetTemp: numberValue(e.target.value),
                  })
                }
              />
            </label>
          </div>
        )}
      </section>

      <section className="brew-editor-section">
        <div className="brew-section-title">
          <h3>כשות</h3>
          <button
            type="button"
            className="brew-action-button brew-action-button-add"
            onClick={addHop}
          >
            + כשות
          </button>
        </div>
        <div className="brew-editor-table">
          {recipe.hops.map((hop) => (
            <div className="brew-editor-row brew-editor-row-hop" key={hop.id}>
              <label>
                כשות
                <select
                  value={hop.ingredientId}
                  onChange={(e) =>
                    updateHop(hop.id, { ingredientId: e.target.value })
                  }
                >
                  {hopOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                מטרה
                <select
                  value={hop.purpose}
                  onChange={(e) => {
                    const purpose = e.target.value as BrewHopPurpose;
                    updateHop(hop.id, {
                      purpose,
                      ...(purpose === "bitterness"
                        ? { aa: hop.aa ?? 0 }
                        : { aa: undefined }),
                    });
                  }}
                >
                  <option value="bitterness">מרירות</option>
                  <option value="aroma">ארומה</option>
                  <option value="whirlpool">ווירפול</option>
                  <option value="dryHop">דרייהופ</option>
                </select>
              </label>
              <label>
                ג׳/ל׳
                <input
                  type="number"
                  step="0.001"
                  value={hop.gramsPerLiter}
                  onChange={(e) =>
                    updateHop(hop.id, {
                      gramsPerLiter: numberValue(e.target.value),
                    })
                  }
                />
              </label>
              {hop.purpose === "bitterness" && (
                <label>
                  aa %
                  <input
                    type="number"
                    step="0.1"
                    value={hop.aa ?? ""}
                    onChange={(e) =>
                      updateHop(hop.id, {
                        aa:
                          e.target.value === ""
                            ? undefined
                            : numberValue(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              <button
                type="button"
                className="brew-icon-button brew-icon-button-danger"
                aria-label="הסר כשות"
                title="הסר כשות"
                onClick={() =>
                  setRecipe((current) => ({
                    ...current,
                    hops: current.hops.filter((item) => item.id !== hop.id),
                  }))
                }
              >
                ×
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
