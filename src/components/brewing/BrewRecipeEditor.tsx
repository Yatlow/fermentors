import { useMemo, useState } from "react";
import type { BrewRecipe, BrewRecipeHop, BrewRecipeMashStep } from "../../SERVICES/brewing/brewRecipe";
import {
  loadSandboxRecipe,
  resetSandboxRecipe,
  saveSandboxRecipe,
} from "../../SERVICES/brewing/sandboxRecipe";

type Props = {
  onRecipeChange?: (recipe: BrewRecipe) => void;
};

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function BrewRecipeEditor({ onRecipeChange }: Props) {
  const [recipe, setRecipe] = useState<BrewRecipe>(() => loadSandboxRecipe());
  const [message, setMessage] = useState("");

  const boilHops = useMemo(
    () => recipe.hops.filter((hop) => hop.phase !== "dryHop"),
    [recipe.hops],
  );
  const dryHops = useMemo(
    () => recipe.hops.filter((hop) => hop.phase === "dryHop"),
    [recipe.hops],
  );

  function updateGrain(index: number, field: "name" | "supplier" | "kgPerBrew", value: string) {
    setRecipe((current) => ({
      ...current,
      grains: current.grains.map((grain, i) =>
        i === index
          ? {
              ...grain,
              [field]: field === "kgPerBrew" ? numberValue(value) : value,
            }
          : grain,
      ),
    }));
    setMessage("");
  }

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
    setMessage("");
  }

  function updateHop(id: string, patch: Partial<BrewRecipeHop>) {
    setRecipe((current) => ({
      ...current,
      hops: current.hops.map((hop) => (hop.id === id ? { ...hop, ...patch } : hop)),
    }));
    setMessage("");
  }

  function save() {
    const next = saveSandboxRecipe(recipe);
    setRecipe(next);
    onRecipeChange?.(next);
    setMessage(`המתכון נשמר ב-Sandbox כגרסה ${next.version}. אצוות שכבר נוצרו לא ישתנו.`);
  }

  function reset() {
    const next = resetSandboxRecipe();
    setRecipe(next);
    onRecipeChange?.(next);
    setMessage("מתכון ה-IPA הוחזר לערכי ברירת המחדל של ה-Sandbox.");
  }

  return (
    <section className="brew-recipe-editor">
      <div className="brewing-panel-heading">
        <div>
          <h2>מתכון IPA</h2>
          <p>
            עריכת Sandbox בלבד. השמירה כאן מדמה את collection ‏brewRecipes; באצווה חדשה
            יישמר snapshot של הגרסה הנוכחית.
          </p>
        </div>
        <span className="brewing-count">v{recipe.version}</span>
      </div>

      {message && <div className="brewing-message">{message}</div>}

      <section className="brew-editor-section">
        <h3>לתת וחומרי מאש</h3>
        <div className="brew-editor-table">
          {recipe.grains.map((grain, index) => (
            <div className="brew-editor-row brew-editor-row-grain" key={grain.id}>
              <label>
                חומר
                <input value={grain.name} onChange={(e) => updateGrain(index, "name", e.target.value)} />
              </label>
              <label>
                ספק
                <input value={grain.supplier} onChange={(e) => updateGrain(index, "supplier", e.target.value)} />
              </label>
              <label>
                ק"ג לבישול
                <input
                  type="number"
                  step="0.1"
                  value={grain.kgPerBrew}
                  onChange={(e) => updateGrain(index, "kgPerBrew", e.target.value)}
                />
              </label>
            </div>
          ))}
        </div>

        <label className="brew-editor-inline-field">
          מי מאש, ליטר
          <input
            type="number"
            step="1"
            value={recipe.mash.waterLiters}
            onChange={(e) =>
              setRecipe((current) => ({
                ...current,
                mash: { ...current.mash, waterLiters: numberValue(e.target.value) },
              }))
            }
          />
        </label>
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
                  onChange={(e) => updateMashStep(index, { targetTemp: numberValue(e.target.value) })}
                />
              </label>
              <label>
                דקות
                <input
                  type="number"
                  step="1"
                  value={step.minutes ?? ""}
                  placeholder="—"
                  onChange={(e) =>
                    updateMashStep(index, {
                      minutes: e.target.value === "" ? undefined : numberValue(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="brew-editor-section">
        <h3>יעדי סוכר</h3>
        <div className="brew-editor-two-cols">
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
            תחילת תסיסה °P
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
        <h3>כשות ברתיחה</h3>
        <div className="brew-editor-table">
          {boilHops.map((hop) => (
            <div className="brew-editor-row brew-editor-row-hop" key={hop.id}>
              <label>
                כשות
                <input value={hop.name} onChange={(e) => updateHop(hop.id, { name: e.target.value })} />
              </label>
              <label>
                AA מתכון %
                <input
                  type="number"
                  step="0.1"
                  value={hop.referenceAlpha}
                  onChange={(e) => updateHop(hop.id, { referenceAlpha: numberValue(e.target.value) })}
                />
              </label>
              <label>
                גרם/ליטר
                <input
                  type="number"
                  step="0.001"
                  value={hop.gramsPerLiter}
                  onChange={(e) => updateHop(hop.id, { gramsPerLiter: numberValue(e.target.value) })}
                />
              </label>
              <label>
                זמן לסוף
                <input
                  type="number"
                  step="1"
                  value={hop.minutesFromEnd ?? 0}
                  onChange={(e) => updateHop(hop.id, { minutesFromEnd: numberValue(e.target.value) })}
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      {dryHops.map((hop) => (
        <section className="brew-editor-section" key={hop.id}>
          <h3>דרייהופ</h3>
          <div className="brew-editor-row brew-editor-row-hop">
            <label>
              כשות
              <input value={hop.name} onChange={(e) => updateHop(hop.id, { name: e.target.value })} />
            </label>
            <label>
              AA ייחוס %
              <input
                type="number"
                step="0.1"
                value={hop.referenceAlpha}
                onChange={(e) => updateHop(hop.id, { referenceAlpha: numberValue(e.target.value) })}
              />
            </label>
            <label>
              גרם/ליטר
              <input
                type="number"
                step="0.001"
                value={hop.gramsPerLiter}
                onChange={(e) => updateHop(hop.id, { gramsPerLiter: numberValue(e.target.value) })}
              />
            </label>
            <label>
              ימים מהבישול
              <input
                type="number"
                step="1"
                value={hop.daysAfterBrew ?? 0}
                onChange={(e) => updateHop(hop.id, { daysAfterBrew: numberValue(e.target.value) })}
              />
            </label>
          </div>
        </section>
      ))}

      <section className="brew-editor-section">
        <h3>שמרים ותסיסה</h3>
        <div className="brew-editor-two-cols">
          <label>
            שמרים
            <input
              value={recipe.yeast.name}
              onChange={(e) =>
                setRecipe((current) => ({
                  ...current,
                  yeast: { ...current.yeast, name: e.target.value },
                }))
              }
            />
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
        <button type="button" className="btn-primary" onClick={save}>שמור מתכון Sandbox</button>
        <button type="button" onClick={reset}>איפוס לברירת מחדל</button>
      </div>
    </section>
  );
}
