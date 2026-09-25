import { useMemo, useState } from "react";
import type {
  BrewHopPurpose,
  BrewRecipe,
  BrewRecipeHop,
  BrewRecipeMashStep,
} from "../../SERVICES/brewing/brewRecipe";
import type { IngredientCategory, IngredientDefinition } from "../../SERVICES/brewing/ingredientLibrary";
import type { CreateIngredientInput } from "../../SERVICES/brewing/ingredientEditorStore";
import IngredientQuickCreateModal from "./IngredientQuickCreateModal";

type Props = {
  recipe: BrewRecipe;
  ingredients: IngredientDefinition[];
  onSave: (recipe: BrewRecipe) => void;
  onBack: () => void;
  onCreateIngredient: (
    input: CreateIngredientInput,
  ) => IngredientDefinition;
};

type IngredientCreateTarget =
  | { kind: "grain"; category: "grain"; index: number }
  | { kind: "hop"; category: "hop"; hopId: string }
  | { kind: "yeast"; category: "yeast" };

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultRestTemps(count: number): number[] {
  if (count <= 1) return [63];
  if (count === 2) return [63, 72];
  if (count === 3) return [45, 63, 72];

  return [
    ...Array.from({ length: Math.max(0, count - 3) }, () => 45),
    45,
    63,
    72,
  ].slice(-count);
}

function isDefaultMashProfile(
  pairs: Array<{
    rest: BrewRecipeMashStep;
    heat?: BrewRecipeMashStep;
  }>,
  mashOutTemp: number,
): boolean {
  const defaults = defaultRestTemps(pairs.length);
  return pairs.every((pair, index) => {
    const restMatches = pair.rest.targetTemp === defaults[index];
    const expectedHeat =
      index < pairs.length - 1
        ? defaults[index + 1]
        : mashOutTemp;
    const heatMatches =
      !pair.heat || pair.heat.targetTemp === expectedHeat;
    return restMatches && heatMatches;
  });
}

export default function BrewRecipeEditor({
  recipe: initialRecipe,
  ingredients,
  onSave,
  onBack,
  onCreateIngredient,
}: Props) {
  const [recipe, setRecipe] = useState<BrewRecipe>(() =>
    JSON.parse(JSON.stringify(initialRecipe)) as BrewRecipe,
  );
  const [ingredientCreateTarget, setIngredientCreateTarget] =
    useState<IngredientCreateTarget | null>(null);

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

  function syncMashChain(steps: BrewRecipeMashStep[]): BrewRecipeMashStep[] {
    if (steps.length < 2) return steps;

    const first = { ...steps[0] };
    const last = { ...steps[steps.length - 1] };
    const middle = steps.slice(1, -1).map((step) => ({ ...step }));

    const rests = middle.filter((_, index) => index % 2 === 0);
    const restTargets = rests.map((rest) => rest.targetTemp);

    if (restTargets.length > 0) {
      first.targetTemp = restTargets[0];
    }

    for (let index = 1; index < middle.length; index += 2) {
      const pairIndex = Math.floor(index / 2);
      const nextRestTarget = restTargets[pairIndex + 1];
      middle[index].targetTemp =
        nextRestTarget !== undefined
          ? nextRestTarget
          : last.targetTemp;
      middle[index].minutes = undefined;
    }

    return [first, ...middle, last];
  }

  function updateMashInTemp(value: number) {
    setRecipe((current) => {
      const steps = current.mash.steps.map((step) => ({ ...step }));
      if (steps[0]) steps[0].targetTemp = value;
      if (steps[1]) steps[1].targetTemp = value;
      return {
        ...current,
        mash: {
          ...current.mash,
          steps: syncMashChain(steps),
        },
      };
    });
  }

  function updateRestTemp(pairIndex: number, value: number) {
    setRecipe((current) => {
      const steps = current.mash.steps.map((step) => ({ ...step }));
      const restIndex = 1 + pairIndex * 2;
      if (steps[restIndex]) steps[restIndex].targetTemp = value;
      return {
        ...current,
        mash: {
          ...current.mash,
          steps: syncMashChain(steps),
        },
      };
    });
  }

  function updateHeatTemp(pairIndex: number, value: number) {
    setRecipe((current) => {
      const steps = current.mash.steps.map((step) => ({ ...step }));
      const heatIndex = 2 + pairIndex * 2;
      if (steps[heatIndex]) steps[heatIndex].targetTemp = value;

      const nextRestIndex = heatIndex + 1;
      if (
        nextRestIndex < steps.length - 1 &&
        steps[nextRestIndex]
      ) {
        steps[nextRestIndex].targetTemp = value;
      } else if (steps.length > 1) {
        steps[steps.length - 1].targetTemp = value;
      }

      return {
        ...current,
        mash: {
          ...current.mash,
          steps: syncMashChain(steps),
        },
      };
    });
  }

  function updateMashOutTemp(value: number) {
    setRecipe((current) => {
      const steps = current.mash.steps.map((step) => ({ ...step }));
      if (steps.length > 0) {
        steps[steps.length - 1].targetTemp = value;
      }
      return {
        ...current,
        mash: {
          ...current.mash,
          steps: syncMashChain(steps),
        },
      };
    });
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
      const currentPairs = Array.from(
        { length: Math.ceil(middle.length / 2) },
        (_, index) => ({
          rest: middle[index * 2],
          heat: middle[index * 2 + 1],
        }),
      ).filter((pair) => !!pair.rest);

      const nextPairCount = currentPairs.length + 1;
      const defaults = defaultRestTemps(nextPairCount);
      const preserveManualValues = !isDefaultMashProfile(
        currentPairs as Array<{
          rest: BrewRecipeMashStep;
          heat?: BrewRecipeMashStep;
        }>,
        last?.targetTemp ?? 78,
      );

      const restTargets = currentPairs.map((pair, index) =>
        preserveManualValues
          ? pair.rest.targetTemp
          : defaults[index],
      );
      restTargets.push(
        preserveManualValues
          ? defaults[nextPairCount - 1] ?? 72
          : defaults[nextPairCount - 1],
      );

      const nextMiddle: BrewRecipeMashStep[] = [];
      restTargets.forEach((targetTemp, index) => {
        const source = currentPairs[index];
        nextMiddle.push({
          ...(source?.rest || {}),
          id: `rest${index + 1}`,
          label: `מנוחה ${index + 1}`,
          targetTemp,
          minutes: source?.rest?.minutes ?? 0,
        });
        nextMiddle.push({
          ...(source?.heat || {}),
          id: `heat${index + 1}`,
          label: `חימום ${index + 1}`,
          targetTemp:
            restTargets[index + 1] ??
            last?.targetTemp ??
            78,
          minutes: undefined,
        });
      });

      const nextSteps = syncMashChain([
        {
          ...first,
          targetTemp: restTargets[0] ?? first?.targetTemp ?? 63,
        },
        ...nextMiddle,
        last,
      ]);

      return {
        ...current,
        mash: {
          ...current.mash,
          steps: nextSteps,
        },
      };
    });
  }

  function removeMashPair(index: number) {
    setRecipe((current) => {
      const first = current.mash.steps[0];
      const last = current.mash.steps[current.mash.steps.length - 1];
      const middle = current.mash.steps.slice(1, -1);

      const currentPairs = Array.from(
        { length: Math.ceil(middle.length / 2) },
        (_, pairIndex) => ({
          rest: middle[pairIndex * 2],
          heat: middle[pairIndex * 2 + 1],
        }),
      ).filter((pair) => !!pair.rest);

      const wasDefault = isDefaultMashProfile(
        currentPairs as Array<{
          rest: BrewRecipeMashStep;
          heat?: BrewRecipeMashStep;
        }>,
        last?.targetTemp ?? 78,
      );

      let nextMiddle = renumberMashMiddle(
        middle.filter(
          (_, stepIndex) =>
            stepIndex !== index * 2 &&
            stepIndex !== index * 2 + 1,
        ),
      );

      if (wasDefault) {
        const nextPairCount = Math.ceil(nextMiddle.length / 2);
        const defaults = defaultRestTemps(nextPairCount);
        nextMiddle = nextMiddle.map((step, stepIndex) => ({
          ...step,
          targetTemp:
            stepIndex % 2 === 0
              ? defaults[Math.floor(stepIndex / 2)] ?? step.targetTemp
              : step.targetTemp,
        }));
      }

      return {
        ...current,
        mash: {
          ...current.mash,
          steps: syncMashChain([
            first,
            ...nextMiddle,
            last,
          ]),
        },
      };
    });
  }

  function addHop() {
    const ingredientId = hopOptions[0]?.id || "";
    setRecipe((current) => {
      const hotSideCount = current.hops.filter(
        (hop) => hop.purpose !== "dryHop",
      ).length;
      const hasDryHop = current.hops.some(
        (hop) => hop.purpose === "dryHop",
      );

      if (hotSideCount >= 3 && hasDryHop) return current;

      const purpose: BrewHopPurpose =
        hotSideCount >= 3 ? "dryHop" : "aroma";

      return {
        ...current,
        hops: [
          ...current.hops,
          {
            id: `hop-${Date.now()}`,
            ingredientId,
            purpose,
            gramsPerLiter: 0,
            ...(purpose === "dryHop" ? {} : { boilMinutes: 10 }),
          },
        ],
      };
    });
  }

  function selectCreatedIngredient(
    input: CreateIngredientInput,
  ) {
    const target = ingredientCreateTarget;
    if (!target) return;

    const created = onCreateIngredient(input);

    if (target.kind === "grain") {
      setRecipe((current) => ({
        ...current,
        grains: current.grains.map((grain, index) =>
          index === target.index
            ? { ...grain, ingredientId: created.id }
            : grain,
        ),
      }));
    } else if (target.kind === "hop") {
      updateHop(target.hopId, { ingredientId: created.id });
    } else {
      setRecipe((current) => ({
        ...current,
        yeast: {
          ...current.yeast,
          ingredientId: created.id,
        },
      }));
    }

    setIngredientCreateTarget(null);
  }

  function ingredientCreateCategory(
    target: IngredientCreateTarget | null,
  ): IngredientCategory {
    return target?.category || "other";
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
                  onChange={(e) => {
                    if (e.target.value === "__create__") {
                      setIngredientCreateTarget({
                        kind: "grain",
                        category: "grain",
                        index,
                      });
                      return;
                    }
                    setRecipe((current) => ({
                      ...current,
                      grains: current.grains.map((item, i) =>
                        i === index
                          ? { ...item, ingredientId: e.target.value }
                          : item,
                      ),
                    }));
                  }}
                >
                  {grainOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  <option disabled>────────</option>
                  <option value="__create__">+ יצירת לתת חדש…</option>
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
                  updateMashInTemp(numberValue(e.target.value))
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
                      updateRestTemp(
                        index,
                        numberValue(e.target.value),
                      )
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
                        updateHeatTemp(
                          index,
                          numberValue(e.target.value),
                        )
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
                  updateMashOutTemp(numberValue(e.target.value))
                }
              />
            </label>
          </div>
        )}
      </section>

      <section className="brew-editor-section">
        <div className="brew-section-title">
          <div>
            <h3>כשות</h3>
            <small>
              עד 3 הכנסות בבישול + דרייהופ אחד בשלב התסיסה
            </small>
          </div>
          <button
            type="button"
            className="brew-action-button brew-action-button-add"
            onClick={addHop}
            disabled={
              recipe.hops.filter((hop) => hop.purpose !== "dryHop").length >= 3 &&
              recipe.hops.some((hop) => hop.purpose === "dryHop")
            }
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
                  onChange={(e) => {
                    if (e.target.value === "__create__") {
                      setIngredientCreateTarget({
                        kind: "hop",
                        category: "hop",
                        hopId: hop.id,
                      });
                      return;
                    }
                    updateHop(hop.id, {
                      ingredientId: e.target.value,
                    });
                  }}
                >
                  {hopOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  <option disabled>────────</option>
                  <option value="__create__">+ יצירת כשות חדש…</option>
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
                        ? {
                            aa: hop.aa ?? 0,
                            boilMinutes: hop.boilMinutes ?? 60,
                          }
                        : { aa: undefined }),
                      ...(purpose === "aroma"
                        ? { boilMinutes: hop.boilMinutes ?? 10 }
                        : {}),
                      ...(purpose === "whirlpool"
                        ? { boilMinutes: hop.boilMinutes ?? 0 }
                        : {}),
                      ...(purpose === "dryHop"
                        ? { boilMinutes: undefined }
                        : {}),
                    });
                  }}
                >
                  <option
                    value="bitterness"
                    disabled={
                      hop.purpose === "dryHop" &&
                      recipe.hops.filter((item) => item.purpose !== "dryHop").length >= 3
                    }
                  >
                    מרירות
                  </option>
                  <option
                    value="aroma"
                    disabled={
                      hop.purpose === "dryHop" &&
                      recipe.hops.filter((item) => item.purpose !== "dryHop").length >= 3
                    }
                  >
                    ארומה
                  </option>
                  <option
                    value="whirlpool"
                    disabled={
                      hop.purpose === "dryHop" &&
                      recipe.hops.filter((item) => item.purpose !== "dryHop").length >= 3
                    }
                  >
                    ווירפול
                  </option>
                  <option
                    value="dryHop"
                    disabled={
                      hop.purpose !== "dryHop" &&
                      recipe.hops.some((item) => item.purpose === "dryHop")
                    }
                  >
                    דרייהופ
                  </option>
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
              {hop.purpose !== "dryHop" && (
                <label>
                  דקות ברתיחה
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={hop.boilMinutes ?? ""}
                    onChange={(e) =>
                      updateHop(hop.id, {
                        boilMinutes:
                          e.target.value === ""
                            ? undefined
                            : numberValue(e.target.value),
                      })
                    }
                  />
                </label>
              )}
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
              onChange={(e) => {
                if (e.target.value === "__create__") {
                  setIngredientCreateTarget({
                    kind: "yeast",
                    category: "yeast",
                  });
                  return;
                }
                setRecipe((current) => ({
                  ...current,
                  yeast: {
                    ...current.yeast,
                    ingredientId: e.target.value,
                  },
                }));
              }}
            >
              <option value="">בחר</option>
              {yeastOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              <option disabled>────────</option>
              <option value="__create__">+ יצירת שמרים חדשים…</option>
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

      <IngredientQuickCreateModal
        open={ingredientCreateTarget !== null}
        category={ingredientCreateCategory(ingredientCreateTarget)}
        onClose={() => setIngredientCreateTarget(null)}
        onCreate={selectCreatedIngredient}
      />
    </section>
  );
}
