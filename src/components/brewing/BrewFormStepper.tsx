import { useMemo, useState } from "react";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
  loadSandboxExecution,
  setSandboxExecutionActiveBlock,
  setSandboxExecutionField,
  type BrewExecution,
} from "../../SERVICES/brewing/sandboxExecution";
import type { SandboxBrewRun } from "../../SERVICES/brewing/brewingSandbox";
import { writeSandboxSheetCells } from "../../SERVICES/brewing/sandboxSheet";

type Props = {
  run: SandboxBrewRun;
  recipe: BrewRecipe;
  onClose: () => void;
};

type StageDef = {
  key: string;
  label: string;
  rowOffset: number;
  showTemp?: boolean;
};

const CORE_STAGES: StageDef[] = [
  { key: "mashIn", label: "הכנסת לתת", rowOffset: 0, showTemp: true },
  { key: "rest1", label: "השריה 1", rowOffset: 2, showTemp: true },
  { key: "heat1", label: "חימום 1", rowOffset: 4, showTemp: true },
  { key: "rest2", label: "השריה 2", rowOffset: 6, showTemp: true },
  { key: "heat2", label: "חימום 2", rowOffset: 8, showTemp: true },
  { key: "transferLt", label: "העברה ל-L.T.", rowOffset: 10, showTemp: true },
  { key: "restLt", label: "מנוחה L.T.", rowOffset: 12 },
  { key: "circulation", label: "סחרור", rowOffset: 14 },
  { key: "outToBoil", label: "הוצאה לבישול", rowOffset: 15 },
  { key: "endTransfer", label: "סוף העברה", rowOffset: 26 },
  { key: "boil", label: "רתיחה 100°C", rowOffset: 28 },
  { key: "hop1", label: "הוספת כשות 1", rowOffset: 30 },
  { key: "hop2", label: "הוספת כשות 2", rowOffset: 32 },
  { key: "hop3", label: "הוספת כשות 3", rowOffset: 34 },
  { key: "wp", label: "סוף רתיחה / תחילת WP", rowOffset: 38 },
  { key: "outToFermentor", label: "הוצאה לתסיסה", rowOffset: 40 },
];

function blockBaseRow(tankType: SandboxBrewRun["tankType"], blockIndex: number): number {
  const rows =
    tankType === "single" ? [9] : tankType === "double" ? [9, 59] : [9, 59, 106];
  return rows[blockIndex - 1] || rows[0];
}

function blockCount(tankType: SandboxBrewRun["tankType"]) {
  return tankType === "single" ? 1 : tankType === "double" ? 2 : 3;
}

function hhmmNow() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function BrewFormStepper({ run, recipe, onClose }: Props) {
  const [execution, setExecution] = useState<BrewExecution>(() =>
    loadSandboxExecution(run.batchNumber),
  );
  const [syncing, setSyncing] = useState("");
  const [message, setMessage] = useState("");

  const currentBlock = Math.min(
    Math.max(execution.activeBlockIndex || 1, 1),
    blockCount(run.tankType),
  );
  const fields = execution.blocks[String(currentBlock)]?.fields || {};
  const baseRow = blockBaseRow(run.tankType, currentBlock);

  const boilTarget = recipe.targets.endBoilPlato;
  const boilRecommendation = useMemo(() => {
    const volume = num(fields.boilSampleVolume || "");
    const plato = num(fields.boilSamplePlato || "");
    if (volume === null || plato === null || !boilTarget) return null;
    return (volume * plato) / boilTarget + 100;
  }, [fields.boilSampleVolume, fields.boilSamplePlato, boilTarget]);

  async function commit(
    key: string,
    value: string,
    writes: Array<{ range: string; value: string | number | boolean | null }>,
  ) {
    const next = setSandboxExecutionField(execution, currentBlock, key, value);
    setExecution(next);
    setMessage("");
    if (!run.sheetId || writes.length === 0) return;

    setSyncing(key);
    try {
      await writeSandboxSheetCells(run.sheetId, writes);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "שמירת הנתון ב-Sheet נכשלה.",
      );
    } finally {
      setSyncing("");
    }
  }

  function localValue(key: string) {
    return fields[key] || "";
  }

  function stageCell(rowOffset: number, column: "E" | "F" | "G" | "H") {
    return `'גיליון1'!${column}${baseRow + rowOffset}`;
  }

  async function commitStage(
    stage: StageDef,
    field: "start" | "end" | "temp",
    value: string,
  ) {
    const col = field === "start" ? "E" : field === "end" ? "F" : "G";
    const cellValue = field === "temp" && value ? `${value}°C` : value;
    await commit(
      `${stage.key}.${field}`,
      value,
      [{ range: stageCell(stage.rowOffset, col), value: cellValue }],
    );
  }

  async function setNow(stage: StageDef, field: "start" | "end") {
    const value = hhmmNow();
    await commitStage(stage, field, value);
  }

  async function commitMashMeta(field: "mashVolume" | "mashPh", value: string) {
    const nextFields = { ...fields, [field]: value };
    const text = [
      nextFields.mashVolume ? `נפח מאש ${nextFields.mashVolume}` : "",
      nextFields.mashPh ? `pH ${nextFields.mashPh}` : "",
    ]
      .filter(Boolean)
      .join("   ");
    await commit(field, value, [{ range: stageCell(0, "H"), value: text }]);
  }

  async function commitPh(
    key: string,
    value: string,
    range: string,
  ) {
    await commit(key, value, [{ range, value: value ? `pH ${value}` : "" }]);
  }

  async function commitRinse(index: number, field: string, value: string) {
    const rowOffset = 18 + (index - 1);
    const key = `rinse${index}.${field}`;
    if (field === "time") {
      return commit(key, value, [{ range: stageCell(rowOffset, "E"), value }]);
    }
    if (field === "amount") {
      return commit(key, value, [{ range: stageCell(rowOffset, "F"), value: num(value) ?? value }]);
    }
    if (field === "temp") {
      return commit(key, value, [{ range: stageCell(rowOffset, "G"), value: value ? `${value}°C` : "" }]);
    }

    const nextFields = { ...fields, [key]: value };
    const kettle = nextFields[`rinse${index}.kettle`] || "";
    const grant = nextFields[`rinse${index}.grant`] || "";
    const display = recipe.lautering.usesGrant && grant ? `${kettle}+${grant}` : kettle;
    return commit(key, value, [{ range: stageCell(rowOffset, "H"), value: display }]);
  }

  async function commitSugar(
    key: string,
    value: string,
    rowOffset: number,
    column: "B" | "C",
    suffix: string,
  ) {
    const parsed = num(value);
    await commit(key, value, [
      {
        range: `'גיליון1'!${column}${baseRow + rowOffset}`,
        value: parsed === null ? "" : `${parsed}${suffix}`,
      },
    ]);
  }

  async function selectBlock(index: number) {
    setExecution(setSandboxExecutionActiveBlock(execution, index));
    setMessage("");
  }

  const targetForStage = (key: string) => {
    if (key === "mashIn") return recipe.mash.steps.find((x) => x.id === "mashIn");
    if (key === "rest1") return recipe.mash.steps.find((x) => x.id === "rest1");
    if (key === "rest2") return recipe.mash.steps.find((x) => x.id === "rest2");
    if (key === "heat2") return recipe.mash.steps.find((x) => x.id === "mashOut");
    return undefined;
  };

  return (
    <section className="brew-stepper">
      <div className="brew-stepper-head">
        <div>
          <button type="button" className="brew-back-button" onClick={onClose}>
            חזרה לאצוות
          </button>
          <h2>אצווה {run.batchNumber} · {run.style} · מיכל {run.tankNumber}</h2>
          <p>
            מתכון v{recipe.version} · {blockCount(run.tankType)} בישולים לאצווה
            {syncing ? " · שומר ל-Sheet..." : ""}
          </p>
        </div>
      </div>

      {message && <div className="brewing-message">{message}</div>}

      <div className="brew-block-tabs">
        {Array.from({ length: blockCount(run.tankType) }, (_, i) => i + 1).map((index) => (
          <button
            type="button"
            key={index}
            className={currentBlock === index ? "active" : ""}
            onClick={() => void selectBlock(index)}
          >
            בישול {index}
          </button>
        ))}
      </div>

      <section className="brew-step-section">
        <div className="brew-section-title">
          <h3>מאש ותהליך</h3>
          <span>מי מאש יעד: {recipe.mash.waterLiters} ל׳</span>
        </div>

        <div className="brew-stage-list">
          {CORE_STAGES.slice(0, 9).map((stage) => {
            const target = targetForStage(stage.key);
            return (
              <div className="brew-stage-row" key={stage.key}>
                <div className="brew-stage-label">
                  <strong>{stage.label}</strong>
                  {target && (
                    <small>
                      יעד {target.targetTemp}°C
                      {target.minutes ? ` · ${target.minutes} דק׳` : ""}
                    </small>
                  )}
                </div>
                <label>
                  התחלה
                  <div className="brew-time-input">
                    <input
                      type="time"
                      value={localValue(`${stage.key}.start`)}
                      onChange={(e) =>
                        setExecution(
                          setSandboxExecutionField(
                            execution,
                            currentBlock,
                            `${stage.key}.start`,
                            e.target.value,
                          ),
                        )
                      }
                      onBlur={(e) => void commitStage(stage, "start", e.target.value)}
                    />
                    <button type="button" onClick={() => void setNow(stage, "start")}>עכשיו</button>
                  </div>
                </label>
                <label>
                  סיום
                  <div className="brew-time-input">
                    <input
                      type="time"
                      value={localValue(`${stage.key}.end`)}
                      onChange={(e) =>
                        setExecution(
                          setSandboxExecutionField(
                            execution,
                            currentBlock,
                            `${stage.key}.end`,
                            e.target.value,
                          ),
                        )
                      }
                      onBlur={(e) => void commitStage(stage, "end", e.target.value)}
                    />
                    <button type="button" onClick={() => void setNow(stage, "end")}>עכשיו</button>
                  </div>
                </label>
                {stage.showTemp && (
                  <label>
                    טמפ׳ בפועל
                    <input
                      type="number"
                      step="0.1"
                      value={localValue(`${stage.key}.temp`)}
                      onChange={(e) =>
                        setExecution(
                          setSandboxExecutionField(
                            execution,
                            currentBlock,
                            `${stage.key}.temp`,
                            e.target.value,
                          ),
                        )
                      }
                      onBlur={(e) => void commitStage(stage, "temp", e.target.value)}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <div className="brew-editor-two-cols">
          <label>
            נפח מאש בפועל
            <input
              type="number"
              value={localValue("mashVolume")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "mashVolume", e.target.value))
              }
              onBlur={(e) => void commitMashMeta("mashVolume", e.target.value)}
            />
          </label>
          <label>
            pH מאש
            <input
              type="number"
              step="0.01"
              value={localValue("mashPh")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "mashPh", e.target.value))
              }
              onBlur={(e) => void commitMashMeta("mashPh", e.target.value)}
            />
          </label>
          <label>
            pH בהוצאה לבישול
            <input
              type="number"
              step="0.01"
              value={localValue("outToBoilPh")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "outToBoilPh", e.target.value))
              }
              onBlur={(e) => void commitPh("outToBoilPh", e.target.value, stageCell(15, "H"))}
            />
          </label>
        </div>
      </section>

      <section className="brew-step-section">
        <div className="brew-section-title">
          <h3>שטיפות</h3>
          <span>{recipe.lautering.usesGrant ? "נפח Kettle + Grant" : "נפח Kettle"}</span>
        </div>
        <div className="brew-rinse-grid">
          {[1, 2, 3, 4, 5, 6, 7].map((index) => (
            <div className="brew-rinse-row" key={index}>
              <strong>שטיפה {index}</strong>
              <label>
                שעה
                <input
                  type="time"
                  value={localValue(`rinse${index}.time`)}
                  onChange={(e) =>
                    setExecution(setSandboxExecutionField(execution, currentBlock, `rinse${index}.time`, e.target.value))
                  }
                  onBlur={(e) => void commitRinse(index, "time", e.target.value)}
                />
              </label>
              <label>
                ליטר
                <input
                  type="number"
                  value={localValue(`rinse${index}.amount`)}
                  onChange={(e) =>
                    setExecution(setSandboxExecutionField(execution, currentBlock, `rinse${index}.amount`, e.target.value))
                  }
                  onBlur={(e) => void commitRinse(index, "amount", e.target.value)}
                />
              </label>
              <label>
                °C
                <input
                  type="number"
                  step="0.1"
                  value={localValue(`rinse${index}.temp`)}
                  onChange={(e) =>
                    setExecution(setSandboxExecutionField(execution, currentBlock, `rinse${index}.temp`, e.target.value))
                  }
                  onBlur={(e) => void commitRinse(index, "temp", e.target.value)}
                />
              </label>
              <label>
                Kettle
                <input
                  type="number"
                  value={localValue(`rinse${index}.kettle`)}
                  onChange={(e) =>
                    setExecution(setSandboxExecutionField(execution, currentBlock, `rinse${index}.kettle`, e.target.value))
                  }
                  onBlur={(e) => void commitRinse(index, "kettle", e.target.value)}
                />
              </label>
              {recipe.lautering.usesGrant && (
                <label>
                  Grant
                  <input
                    type="number"
                    value={localValue(`rinse${index}.grant`)}
                    onChange={(e) =>
                      setExecution(setSandboxExecutionField(execution, currentBlock, `rinse${index}.grant`, e.target.value))
                    }
                    onBlur={(e) => void commitRinse(index, "grant", e.target.value)}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="brew-step-section">
        <div className="brew-section-title">
          <h3>רתיחה וכשות</h3>
          <span>יעד סוף רתיחה: {recipe.targets.endBoilPlato}°P</span>
        </div>

        <div className="brew-stage-list">
          {CORE_STAGES.slice(9, 15).map((stage) => (
            <div className="brew-stage-row" key={stage.key}>
              <div className="brew-stage-label">
                <strong>{stage.label}</strong>
              </div>
              <label>
                התחלה
                <div className="brew-time-input">
                  <input
                    type="time"
                    value={localValue(`${stage.key}.start`)}
                    onChange={(e) =>
                      setExecution(setSandboxExecutionField(execution, currentBlock, `${stage.key}.start`, e.target.value))
                    }
                    onBlur={(e) => void commitStage(stage, "start", e.target.value)}
                  />
                  <button type="button" onClick={() => void setNow(stage, "start")}>עכשיו</button>
                </div>
              </label>
              {["endTransfer", "boil", "wp"].includes(stage.key) && (
                <label>
                  סיום
                  <div className="brew-time-input">
                    <input
                      type="time"
                      value={localValue(`${stage.key}.end`)}
                      onChange={(e) =>
                        setExecution(setSandboxExecutionField(execution, currentBlock, `${stage.key}.end`, e.target.value))
                      }
                      onBlur={(e) => void commitStage(stage, "end", e.target.value)}
                    />
                    <button type="button" onClick={() => void setNow(stage, "end")}>עכשיו</button>
                  </div>
                </label>
              )}
            </div>
          ))}
        </div>

        <div className="brew-editor-two-cols">
          <label>
            pH תחילת רתיחה
            <input
              type="number"
              step="0.01"
              value={localValue("boilPh")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "boilPh", e.target.value))
              }
              onBlur={(e) => void commitPh("boilPh", e.target.value, stageCell(28, "F"))}
            />
          </label>
          <label>
            נפח בדיקת רתיחה
            <input
              type="number"
              value={localValue("boilSampleVolume") || "1200"}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "boilSampleVolume", e.target.value))
              }
            />
          </label>
          <label>
            Plato בדיקה
            <input
              type="number"
              step="0.01"
              value={localValue("boilSamplePlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "boilSamplePlato", e.target.value))
              }
            />
          </label>
          <div className="brew-calc-result">
            <span>עצירת מילוי מומלצת</span>
            <strong>{boilRecommendation === null ? "—" : `${Math.round(boilRecommendation)} ל׳`}</strong>
            <small>לפי יעד {boilTarget}°P ואידוי 100 ל׳</small>
          </div>
        </div>
      </section>

      <section className="brew-step-section">
        <div className="brew-section-title">
          <h3>סוכר והוצאה לתסיסה</h3>
          <span>סוכר תחילי מחושב בנפרד כממוצע נע ומשוקלל</span>
        </div>

        <div className="brew-sugar-grid">
          <label>
            F.R.
            <input
              type="number"
              step="0.01"
              value={localValue("frPlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "frPlato", e.target.value))
              }
              onBlur={(e) => void commitSugar("frPlato", e.target.value, 36, "B", "°P")}
            />
          </label>
          <label>
            L.R.
            <input
              type="number"
              step="0.01"
              value={localValue("lrPlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "lrPlato", e.target.value))
              }
              onBlur={(e) => void commitSugar("lrPlato", e.target.value, 37, "B", "°P")}
            />
          </label>
          <label>
            Plato בסיר
            <input
              type="number"
              step="0.01"
              value={localValue("kettlePlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "kettlePlato", e.target.value))
              }
              onBlur={(e) => void commitSugar("kettlePlato", e.target.value, 38, "B", "°P")}
            />
          </label>
          <label>
            נפח בסיר
            <input
              type="number"
              value={localValue("kettleVolume")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "kettleVolume", e.target.value))
              }
              onBlur={(e) => void commitSugar("kettleVolume", e.target.value, 38, "C", "")}
            />
          </label>
          <label>
            סוף רתיחה °P
            <input
              type="number"
              step="0.01"
              value={localValue("endBoilPlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "endBoilPlato", e.target.value))
              }
              onBlur={(e) => void commitSugar("endBoilPlato", e.target.value, 39, "B", "°P")}
            />
          </label>
          <label>
            נפח סוף רתיחה
            <input
              type="number"
              value={localValue("endBoilVolume")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "endBoilVolume", e.target.value))
              }
              onBlur={(e) => void commitSugar("endBoilVolume", e.target.value, 39, "C", "")}
            />
          </label>
          <label>
            דגימת תחילת תסיסה °P
            <input
              type="number"
              step="0.01"
              value={localValue("fermentorSamplePlato")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "fermentorSamplePlato", e.target.value))
              }
              onBlur={(e) => void commitSugar("fermentorSamplePlato", e.target.value, 40, "B", "°P")}
            />
          </label>
          <label>
            נפח מצטבר במיכל
            <input
              type="number"
              value={localValue("cumulativeTankVolume")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "cumulativeTankVolume", e.target.value))
              }
              onBlur={(e) => void commitSugar("cumulativeTankVolume", e.target.value, 40, "C", "")}
            />
          </label>
          <label>
            pH בהוצאה לתסיסה
            <input
              type="number"
              step="0.01"
              value={localValue("outToFermentorPh")}
              onChange={(e) =>
                setExecution(setSandboxExecutionField(execution, currentBlock, "outToFermentorPh", e.target.value))
              }
              onBlur={(e) => void commitPh("outToFermentorPh", e.target.value, stageCell(40, "H"))}
            />
          </label>
        </div>
      </section>
    </section>
  );
}
