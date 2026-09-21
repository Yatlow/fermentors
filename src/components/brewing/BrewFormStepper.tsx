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
import { calculateWeightedStartingPlato } from "../../SERVICES/brewing/startingPlato";

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
  targetRecipeStepId?: string;
};

type StepId = "mash" | "lautering" | "boil" | "transfer" | "summary";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "mash", label: "מאש" },
  { id: "lautering", label: "לאוטר" },
  { id: "boil", label: "רתיחה וכשות" },
  { id: "transfer", label: "WP והוצאה" },
  { id: "summary", label: "סיכום" },
];

const MASH_STAGES: StageDef[] = [
  {
    key: "mashIn",
    label: "הכנסת לתת",
    rowOffset: 0,
    showTemp: true,
    targetRecipeStepId: "mashIn",
  },
  {
    key: "rest1",
    label: "השריה 1",
    rowOffset: 2,
    showTemp: true,
    targetRecipeStepId: "rest1",
  },
  { key: "heat1", label: "חימום 1", rowOffset: 4, showTemp: true },
  {
    key: "rest2",
    label: "השריה 2",
    rowOffset: 6,
    showTemp: true,
    targetRecipeStepId: "rest2",
  },
  {
    key: "heat2",
    label: "חימום 2",
    rowOffset: 8,
    showTemp: true,
    targetRecipeStepId: "mashOut",
  },
];

const LAUTER_STAGES: StageDef[] = [
  { key: "transferLt", label: "העברה ל-L.T.", rowOffset: 10, showTemp: true },
  { key: "restLt", label: "מנוחה L.T.", rowOffset: 12 },
  { key: "circulation", label: "סחרור", rowOffset: 14 },
  { key: "outToBoil", label: "הוצאה לבישול", rowOffset: 15 },
];

const END_TRANSFER_STAGE: StageDef = {
  key: "endTransfer",
  label: "סוף העברה",
  rowOffset: 26,
};

const BOIL_STAGES: StageDef[] = [
  { key: "boil", label: "רתיחה 100°C", rowOffset: 28 },
  { key: "hop1", label: "הוספת כשות 1", rowOffset: 30 },
  { key: "hop2", label: "הוספת כשות 2", rowOffset: 32 },
  { key: "hop3", label: "הוספת כשות 3", rowOffset: 34 },
];

const WP_STAGE: StageDef = {
  key: "wp",
  label: "סוף רתיחה / תחילת WP",
  rowOffset: 38,
};

const OUT_STAGE: StageDef = {
  key: "outToFermentor",
  label: "הוצאה לתסיסה",
  rowOffset: 40,
};

const TIMELINE_STAGES: StageDef[] = [
  ...MASH_STAGES,
  ...LAUTER_STAGES,
  END_TRANSFER_STAGE,
  ...BOIL_STAGES,
  WP_STAGE,
  OUT_STAGE,
];

function blockBaseRow(
  tankType: SandboxBrewRun["tankType"],
  blockIndex: number,
): number {
  const rows =
    tankType === "single" ? [9] : tankType === "double" ? [9, 59] : [9, 59, 106];
  return rows[blockIndex - 1] || rows[0];
}

function getBlockCount(tankType: SandboxBrewRun["tankType"]) {
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

function addMinutesToTime(value: string, minutes: number): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60);
  const normalized = total < 0 ? total + 24 * 60 : total;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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
  const [activeStep, setActiveStep] = useState(0);
  const [syncing, setSyncing] = useState("");
  const [message, setMessage] = useState("");

  const totalBlocks = getBlockCount(run.tankType);
  const currentBlock = Math.min(
    Math.max(execution.activeBlockIndex || 1, 1),
    totalBlocks,
  );
  const fields = execution.blocks[String(currentBlock)]?.fields || {};
  const baseRow = blockBaseRow(run.tankType, currentBlock);
  const currentStep = STEPS[activeStep];

  const startingPlato = useMemo(
    () =>
      calculateWeightedStartingPlato(
        Array.from({ length: totalBlocks }, (_, index) => {
          const blockFields = execution.blocks[String(index + 1)]?.fields || {};
          return {
            endBoilPlato: num(blockFields.endBoilPlato || ""),
            cumulativeTankVolumeLiters: num(
              blockFields.cumulativeTankVolume || "",
            ),
          };
        }),
      ),
    [execution.blocks, totalBlocks],
  );

  const boilRecommendation = useMemo(() => {
    const volume = num(fields.boilSampleVolume || "1200");
    const plato = num(fields.boilSamplePlato || "");
    if (volume === null || plato === null || !recipe.targets.endBoilPlato) {
      return null;
    }
    return (volume * plato) / recipe.targets.endBoilPlato + 100;
  }, [
    fields.boilSampleVolume,
    fields.boilSamplePlato,
    recipe.targets.endBoilPlato,
  ]);

  const visibleRinseCount = useMemo(() => {
    let highestWithData = 0;

    for (let index = 1; index <= 7; index += 1) {
      const keys = [
        `rinse${index}.time`,
        `rinse${index}.amount`,
        `rinse${index}.temp`,
        `rinse${index}.kettle`,
        `rinse${index}.grant`,
      ];
      if (keys.some((key) => String(fields[key] || "").trim() !== "")) {
        highestWithData = index;
      }
    }

    if (highestWithData === 0) return 1;

    const requiredKeys = [
      `rinse${highestWithData}.time`,
      `rinse${highestWithData}.amount`,
      `rinse${highestWithData}.temp`,
      `rinse${highestWithData}.kettle`,
      ...(recipe.lautering.usesGrant
        ? [`rinse${highestWithData}.grant`]
        : []),
    ];

    const completed = requiredKeys.every(
      (key) => String(fields[key] || "").trim() !== "",
    );

    return Math.min(7, completed ? highestWithData + 1 : highestWithData);
  }, [fields, recipe.lautering.usesGrant]);

  const missingItems = useMemo(() => {
    const items: string[] = [];
    if (!fields["mashIn.start"]) items.push("זמן התחלת הכנסת לתת");
    if (!fields.mashPh) items.push("pH מאש");
    if (!fields.outToBoilPh) items.push("pH בהוצאה לבישול");
    if (!fields.boilPh) items.push("pH תחילת רתיחה");
    if (!fields.endBoilPlato) items.push("Plato סוף רתיחה");
    if (!fields.cumulativeTankVolume) items.push("נפח מצטבר במיכל");
    if (!fields["outToFermentor.start"]) {
      items.push("זמן התחלת הוצאה לתסיסה");
    }
    return items;
  }, [fields]);

  async function writeSheet(
    key: string,
    writes: Array<{ range: string; value: string | number | boolean | null }>,
  ) {
    if (!run.sheetId || writes.length === 0) return;

    setSyncing(key);
    setMessage("");
    try {
      await writeSandboxSheetCells(run.sheetId, writes);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "שמירת הנתון ב-Sheet נכשלה.",
      );
    } finally {
      setSyncing("");
    }
  }

  async function commit(
    key: string,
    value: string,
    writes: Array<{ range: string; value: string | number | boolean | null }>,
  ) {
    const next = setSandboxExecutionField(
      execution,
      currentBlock,
      key,
      value,
    );
    setExecution(next);
    await writeSheet(key, writes);
  }

  function localValue(key: string) {
    return fields[key] || "";
  }

  function stageCell(
    rowOffset: number,
    column: "E" | "F" | "G" | "H",
  ) {
    return `'גיליון1'!${column}${baseRow + rowOffset}`;
  }

  function knownDuration(stage: StageDef): number | null {
    if (!stage.targetRecipeStepId) return null;
    const recipeStep = recipe.mash.steps.find(
      (step) => step.id === stage.targetRecipeStepId,
    );
    const minutes = Number(recipeStep?.minutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  }

  function nextTimelineStage(stage: StageDef): StageDef | null {
    const index = TIMELINE_STAGES.findIndex((item) => item.key === stage.key);
    return index >= 0 ? TIMELINE_STAGES[index + 1] || null : null;
  }

  async function commitStageStart(stage: StageDef, value: string) {
    let nextExecution = setSandboxExecutionField(
      execution,
      currentBlock,
      `${stage.key}.start`,
      value,
    );

    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [{ range: stageCell(stage.rowOffset, "E"), value }];

    const duration = knownDuration(stage);
    if (value && duration !== null) {
      const calculatedEnd = addMinutesToTime(value, duration);
      const nextStage = nextTimelineStage(stage);

      nextExecution = setSandboxExecutionField(
        nextExecution,
        currentBlock,
        `${stage.key}.end`,
        calculatedEnd,
      );
      writes.push({
        range: stageCell(stage.rowOffset, "F"),
        value: calculatedEnd,
      });

      if (nextStage) {
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          `${nextStage.key}.start`,
          calculatedEnd,
        );
        writes.push({
          range: stageCell(nextStage.rowOffset, "E"),
          value: calculatedEnd,
        });
      }
    }

    setExecution(nextExecution);
    await writeSheet(`${stage.key}.start`, writes);
  }

  async function commitStage(
    stage: StageDef,
    field: "end" | "temp",
    value: string,
  ) {
    const col = field === "end" ? "F" : "G";
    const cellValue = field === "temp" && value ? `${value}°C` : value;
    await commit(`${stage.key}.${field}`, value, [
      { range: stageCell(stage.rowOffset, col), value: cellValue },
    ]);
  }

  async function setNow(stage: StageDef, field: "start" | "end") {
    const value = hhmmNow();
    if (field === "start") {
      await commitStageStart(stage, value);
      return;
    }
    await commitStage(stage, "end", value);
  }

  async function commitMashMeta(
    field: "mashVolume" | "mashPh",
    value: string,
  ) {
    const nextFields = { ...fields, [field]: value };
    const text = [
      nextFields.mashVolume ? `נפח מאש ${nextFields.mashVolume}` : "",
      nextFields.mashPh ? `pH ${nextFields.mashPh}` : "",
    ]
      .filter(Boolean)
      .join("   ");
    await commit(field, value, [{ range: stageCell(0, "H"), value: text }]);
  }

  async function commitPh(key: string, value: string, range: string) {
    await commit(key, value, [
      { range, value: value ? `pH ${value}` : "" },
    ]);
  }

  async function commitRinse(
    index: number,
    field: string,
    value: string,
  ) {
    const rowOffset = 18 + (index - 1);
    const key = `rinse${index}.${field}`;

    if (field === "time") {
      return commit(key, value, [
        { range: stageCell(rowOffset, "E"), value },
      ]);
    }
    if (field === "amount") {
      return commit(key, value, [
        { range: stageCell(rowOffset, "F"), value: num(value) ?? value },
      ]);
    }
    if (field === "temp") {
      return commit(key, value, [
        {
          range: stageCell(rowOffset, "G"),
          value: value ? `${value}°C` : "",
        },
      ]);
    }

    const nextFields = { ...fields, [key]: value };
    const kettle = nextFields[`rinse${index}.kettle`] || "";
    const grant = nextFields[`rinse${index}.grant`] || "";
    const display =
      recipe.lautering.usesGrant && grant ? `${kettle}+${grant}` : kettle;
    return commit(key, value, [
      { range: stageCell(rowOffset, "H"), value: display },
    ]);
  }

  async function commitSugar(
    key: string,
    value: string,
    rowOffset: number,
    column: "B" | "C",
  ) {
    const parsed = num(value);
    await commit(key, value, [
      {
        range: `'גיליון1'!${column}${baseRow + rowOffset}`,
        value: parsed === null ? "" : parsed,
      },
    ]);
  }

  async function selectBlock(index: number) {
    setExecution(setSandboxExecutionActiveBlock(execution, index));
    setActiveStep(0);
    setMessage("");
  }

  function setLocal(key: string, value: string) {
    setExecution(
      setSandboxExecutionField(execution, currentBlock, key, value),
    );
  }

  function renderStageRows(stages: StageDef[]) {
    return (
      <div className="brew-stage-list">
        {stages.map((stage) => {
          const target = stage.targetRecipeStepId
            ? recipe.mash.steps.find(
                (step) => step.id === stage.targetRecipeStepId,
              )
            : undefined;
          const duration = knownDuration(stage);

          return (
            <div className="brew-stage-row" key={stage.key}>
              <div className="brew-stage-label">
                <strong>{stage.label}</strong>
                {target && (
                  <small>
                    יעד {target.targetTemp}°C
                    {duration ? ` · ${duration} דק׳` : ""}
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
                      void commitStageStart(stage, e.target.value)
                    }
                  />
                  <button
                    type="button"
                    onClick={() => void setNow(stage, "start")}
                  >
                    עכשיו
                  </button>
                </div>
              </label>

              <label>
                סיום
                <div className="brew-time-input">
                  <input
                    type="time"
                    value={localValue(`${stage.key}.end`)}
                    onChange={(e) =>
                      setLocal(`${stage.key}.end`, e.target.value)
                    }
                    onBlur={(e) =>
                      void commitStage(stage, "end", e.target.value)
                    }
                  />
                  <button
                    type="button"
                    onClick={() => void setNow(stage, "end")}
                  >
                    עכשיו
                  </button>
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
                      setLocal(`${stage.key}.temp`, e.target.value)
                    }
                    onBlur={(e) =>
                      void commitStage(stage, "temp", e.target.value)
                    }
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="brew-stepper">
      <div className="brew-stepper-head">
        <div>
          <button
            type="button"
            className="brew-back-button"
            onClick={onClose}
          >
            חזרה לאצוות
          </button>
          <h2>
            אצווה {run.batchNumber} · {run.style} · מיכל {run.tankNumber}
          </h2>
          <p>
            בישול {currentBlock}/{totalBlocks} · מתכון v{recipe.version}
            {syncing ? " · שומר ל-Sheet..." : " · מסונכרן"}
          </p>
        </div>
      </div>

      {message && <div className="brewing-message">{message}</div>}

      <div className="brew-block-tabs">
        {Array.from({ length: totalBlocks }, (_, index) => index + 1).map(
          (index) => (
            <button
              type="button"
              key={index}
              className={currentBlock === index ? "active" : ""}
              onClick={() => void selectBlock(index)}
            >
              בישול {index}
            </button>
          ),
        )}
      </div>

      <nav className="brew-step-progress" aria-label="שלבי טופס הבישול">
        {STEPS.map((step, index) => (
          <button
            type="button"
            key={step.id}
            className={[
              index === activeStep ? "active" : "",
              index < activeStep ? "done" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => setActiveStep(index)}
          >
            <span>{index < activeStep ? "✓" : index + 1}</span>
            <strong>{step.label}</strong>
          </button>
        ))}
      </nav>

      <section className="brew-step-panel">
        <div className="brew-step-panel-head">
          <div>
            <span>
              שלב {activeStep + 1} מתוך {STEPS.length}
            </span>
            <h3>{currentStep.label}</h3>
          </div>
        </div>

        {currentStep.id === "mash" && (
          <>
            <div className="brew-section-title">
              <span>מי מאש יעד: {recipe.mash.waterLiters} ל׳</span>
            </div>

            {renderStageRows(MASH_STAGES)}

            <div className="brew-editor-two-cols">
              <label>
                נפח מאש בפועל
                <input
                  type="number"
                  value={localValue("mashVolume")}
                  onChange={(e) =>
                    setLocal("mashVolume", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitMashMeta("mashVolume", e.target.value)
                  }
                />
              </label>

              <label>
                pH מאש
                <input
                  type="number"
                  step="0.01"
                  value={localValue("mashPh")}
                  onChange={(e) => setLocal("mashPh", e.target.value)}
                  onBlur={(e) =>
                    void commitMashMeta("mashPh", e.target.value)
                  }
                />
              </label>
            </div>
          </>
        )}

        {currentStep.id === "lautering" && (
          <>
            {renderStageRows(LAUTER_STAGES)}

            <label className="brew-editor-inline-field">
              pH בהוצאה לבישול
              <input
                type="number"
                step="0.01"
                value={localValue("outToBoilPh")}
                onChange={(e) =>
                  setLocal("outToBoilPh", e.target.value)
                }
                onBlur={(e) =>
                  void commitPh(
                    "outToBoilPh",
                    e.target.value,
                    stageCell(15, "H"),
                  )
                }
              />
            </label>

            <div className="brew-lauter-subsection">
              <div className="brew-section-title">
                <div>
                  <h4>שטיפות</h4>
                  <span>
                    {recipe.lautering.usesGrant
                      ? "נפח Kettle + Grant"
                      : "נפח Kettle"}
                  </span>
                </div>
                <small>
                  שטיפה חדשה נפתחת אוטומטית כשהקודמת מלאה
                </small>
              </div>

              <div className="brew-rinse-grid">
                {Array.from(
                  { length: visibleRinseCount },
                  (_, index) => index + 1,
                ).map((index) => (
                  <div className="brew-rinse-row" key={index}>
                    <strong>שטיפה {index}</strong>

                    <label>
                      שעה
                      <input
                        type="time"
                        value={localValue(`rinse${index}.time`)}
                        onChange={(e) =>
                          setLocal(
                            `rinse${index}.time`,
                            e.target.value,
                          )
                        }
                        onBlur={(e) =>
                          void commitRinse(
                            index,
                            "time",
                            e.target.value,
                          )
                        }
                      />
                    </label>

                    <label>
                      ליטר
                      <input
                        type="number"
                        value={localValue(`rinse${index}.amount`)}
                        onChange={(e) =>
                          setLocal(
                            `rinse${index}.amount`,
                            e.target.value,
                          )
                        }
                        onBlur={(e) =>
                          void commitRinse(
                            index,
                            "amount",
                            e.target.value,
                          )
                        }
                      />
                    </label>

                    <label>
                      °C
                      <input
                        type="number"
                        step="0.1"
                        value={localValue(`rinse${index}.temp`)}
                        onChange={(e) =>
                          setLocal(
                            `rinse${index}.temp`,
                            e.target.value,
                          )
                        }
                        onBlur={(e) =>
                          void commitRinse(
                            index,
                            "temp",
                            e.target.value,
                          )
                        }
                      />
                    </label>

                    <label>
                      Kettle
                      <input
                        type="number"
                        value={localValue(`rinse${index}.kettle`)}
                        onChange={(e) =>
                          setLocal(
                            `rinse${index}.kettle`,
                            e.target.value,
                          )
                        }
                        onBlur={(e) =>
                          void commitRinse(
                            index,
                            "kettle",
                            e.target.value,
                          )
                        }
                      />
                    </label>

                    {recipe.lautering.usesGrant && (
                      <label>
                        Grant
                        <input
                          type="number"
                          value={localValue(
                            `rinse${index}.grant`,
                          )}
                          onChange={(e) =>
                            setLocal(
                              `rinse${index}.grant`,
                              e.target.value,
                            )
                          }
                          onBlur={(e) =>
                            void commitRinse(
                              index,
                              "grant",
                              e.target.value,
                            )
                          }
                        />
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="brew-lauter-subsection">
              <div className="brew-section-title">
                <div>
                  <h4>לקראת סוף הלאוטר</h4>
                  <span>
                    לפי הדגימה מחליטים באיזה נפח להפסיק למלא את הסיר
                  </span>
                </div>
              </div>

              <div className="brew-editor-two-cols">
                <label>
                  נפח בזמן הדגימה
                  <input
                    type="number"
                    value={
                      localValue("boilSampleVolume") || "1200"
                    }
                    onChange={(e) =>
                      setLocal(
                        "boilSampleVolume",
                        e.target.value,
                      )
                    }
                  />
                </label>

                <label>
                  Plato בדגימה
                  <input
                    type="number"
                    step="0.01"
                    value={localValue("boilSamplePlato")}
                    onChange={(e) =>
                      setLocal(
                        "boilSamplePlato",
                        e.target.value,
                      )
                    }
                  />
                </label>

                <div className="brew-calc-result">
                  <span>עצירת מילוי מומלצת</span>
                  <strong>
                    {boilRecommendation === null
                      ? "—"
                      : `${Math.round(boilRecommendation)} ל׳`}
                  </strong>
                  <small>
                    לפי ה-Plato שנמדד ויעד סוף הרתיחה{" "}
                    {recipe.targets.endBoilPlato}°P
                  </small>
                </div>
              </div>
            </div>

            <div className="brew-lauter-end-transfer">
              {renderStageRows([END_TRANSFER_STAGE])}
            </div>
          </>
        )}

        {currentStep.id === "boil" && (
          <>
            <div className="brew-section-title">
              <span>
                יעד סוף רתיחה: {recipe.targets.endBoilPlato}°P
              </span>
            </div>

            {renderStageRows(BOIL_STAGES)}

            <label className="brew-editor-inline-field">
              pH תחילת רתיחה
              <input
                type="number"
                step="0.01"
                value={localValue("boilPh")}
                onChange={(e) => setLocal("boilPh", e.target.value)}
                onBlur={(e) =>
                  void commitPh(
                    "boilPh",
                    e.target.value,
                    stageCell(28, "F"),
                  )
                }
              />
            </label>
          </>
        )}

        {currentStep.id === "transfer" && (
          <>
            {renderStageRows([WP_STAGE, OUT_STAGE])}

            <div className="brew-starting-plato-live">
              <span>סוכר תחילי מחושב</span>
              <strong>
                {startingPlato.value === null
                  ? "—"
                  : `${startingPlato.value.toFixed(2)}°P`}
              </strong>
              <small>
                {startingPlato.value === null
                  ? "ממתין לסוף רתיחה + נפח מצטבר"
                  : startingPlato.isPartial
                    ? `זמני · ${startingPlato.completedBlocks}/${totalBlocks} בישולים`
                    : "סופי · ממוצע נע ומשוקלל לפי נפחים"}
              </small>
            </div>

            <div className="brew-sugar-grid">
              <label>
                F.R.
                <input
                  type="number"
                  step="0.01"
                  value={localValue("frPlato")}
                  onChange={(e) =>
                    setLocal("frPlato", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "frPlato",
                      e.target.value,
                      36,
                      "B",
                    )
                  }
                />
              </label>

              <label>
                L.R.
                <input
                  type="number"
                  step="0.01"
                  value={localValue("lrPlato")}
                  onChange={(e) =>
                    setLocal("lrPlato", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "lrPlato",
                      e.target.value,
                      37,
                      "B",
                    )
                  }
                />
              </label>

              <label>
                Plato בסיר
                <input
                  type="number"
                  step="0.01"
                  value={localValue("kettlePlato")}
                  onChange={(e) =>
                    setLocal("kettlePlato", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "kettlePlato",
                      e.target.value,
                      38,
                      "B",
                    )
                  }
                />
              </label>

              <label>
                נפח בסיר
                <input
                  type="number"
                  value={localValue("kettleVolume")}
                  onChange={(e) =>
                    setLocal("kettleVolume", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "kettleVolume",
                      e.target.value,
                      38,
                      "C",
                    )
                  }
                />
              </label>

              <label>
                סוף רתיחה °P
                <input
                  type="number"
                  step="0.01"
                  value={localValue("endBoilPlato")}
                  onChange={(e) =>
                    setLocal(
                      "endBoilPlato",
                      e.target.value,
                    )
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "endBoilPlato",
                      e.target.value,
                      39,
                      "B",
                    )
                  }
                />
              </label>

              <label>
                נפח סוף רתיחה
                <input
                  type="number"
                  value={localValue("endBoilVolume")}
                  onChange={(e) =>
                    setLocal(
                      "endBoilVolume",
                      e.target.value,
                    )
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "endBoilVolume",
                      e.target.value,
                      39,
                      "C",
                    )
                  }
                />
              </label>

              <label>
                דגימת תחילת תסיסה °P
                <input
                  type="number"
                  step="0.01"
                  value={localValue(
                    "fermentorSamplePlato",
                  )}
                  onChange={(e) =>
                    setLocal(
                      "fermentorSamplePlato",
                      e.target.value,
                    )
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "fermentorSamplePlato",
                      e.target.value,
                      40,
                      "B",
                    )
                  }
                />
              </label>

              <label>
                נפח מצטבר במיכל
                <input
                  type="number"
                  value={localValue(
                    "cumulativeTankVolume",
                  )}
                  onChange={(e) =>
                    setLocal(
                      "cumulativeTankVolume",
                      e.target.value,
                    )
                  }
                  onBlur={(e) =>
                    void commitSugar(
                      "cumulativeTankVolume",
                      e.target.value,
                      40,
                      "C",
                    )
                  }
                />
              </label>

              <label>
                pH בהוצאה לתסיסה
                <input
                  type="number"
                  step="0.01"
                  value={localValue(
                    "outToFermentorPh",
                  )}
                  onChange={(e) =>
                    setLocal(
                      "outToFermentorPh",
                      e.target.value,
                    )
                  }
                  onBlur={(e) =>
                    void commitPh(
                      "outToFermentorPh",
                      e.target.value,
                      stageCell(40, "H"),
                    )
                  }
                />
              </label>
            </div>
          </>
        )}

        {currentStep.id === "summary" && (
          <div className="brew-step-summary">
            <div className="brew-summary-card">
              <span>בישול</span>
              <strong>
                {currentBlock}/{totalBlocks}
              </strong>
            </div>

            <div className="brew-summary-card">
              <span>סוכר תחילי מחושב</span>
              <strong>
                {startingPlato.value === null
                  ? "—"
                  : `${startingPlato.value.toFixed(2)}°P`}
              </strong>
            </div>

            <div className="brew-summary-missing">
              <h4>
                {missingItems.length
                  ? `חסרים ${missingItems.length} נתונים`
                  : "אין חוסרים בולטים בשלב זה"}
              </h4>

              {missingItems.length > 0 && (
                <ul>
                  {missingItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}

              <p>
                החוסרים אינם חוסמים מעבר, שמירה או יציאה מהבישול.
              </p>
            </div>
          </div>
        )}
      </section>

      <div className="brew-step-footer">
        <button
          type="button"
          onClick={() =>
            setActiveStep((value) => Math.max(0, value - 1))
          }
          disabled={activeStep === 0}
        >
          הקודם
        </button>

        <span>{currentStep.label}</span>

        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            setActiveStep((value) =>
              Math.min(STEPS.length - 1, value + 1),
            )
          }
          disabled={activeStep === STEPS.length - 1}
        >
          הבא
        </button>
      </div>
    </section>
  );
}
