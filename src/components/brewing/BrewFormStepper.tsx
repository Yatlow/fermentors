import { useMemo, useState } from "react";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
  loadSandboxExecution,
  replaceSandboxExecutionBlockFields,
  setSandboxExecutionActiveBlock,
  setSandboxExecutionField,
  type BrewExecution,
} from "../../SERVICES/brewing/sandboxExecution";
import type { SandboxBrewRun } from "../../SERVICES/brewing/brewingSandbox";
import {
  readSandboxSheetRange,
  writeSandboxSheetCells,
} from "../../SERVICES/brewing/sandboxSheet";
import BeerLoader from "../general/Loading";
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
  showNote?: boolean;
  showEnd?: boolean;
  defaultMinutes?: number;
  targetRecipeStepId?: string;
};

type StepId =
  | "water"
  | "mash"
  | "lautering"
  | "boil"
  | "transfer"
  | "summary";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "water", label: "מים" },
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
    showNote: true,
    targetRecipeStepId: "mashIn",
  },
  {
    key: "rest1",
    label: "השריה 1",
    rowOffset: 2,
    showTemp: true,
    showNote: true,
    targetRecipeStepId: "rest1",
  },
  {
    key: "heat1",
    label: "חימום 1",
    rowOffset: 4,
    showTemp: true,
    showNote: true,
    targetRecipeStepId: "heat1",
  },
  {
    key: "rest2",
    label: "השריה 2",
    rowOffset: 6,
    showTemp: true,
    showNote: true,
    targetRecipeStepId: "rest2",
  },
  {
    key: "heat2",
    label: "חימום 2",
    rowOffset: 8,
    showTemp: true,
    showNote: true,
    targetRecipeStepId: "heat2",
  },
];

const LAUTER_STAGES: StageDef[] = [
  {
    key: "transferLt",
    label: "העברה ל-L.T.",
    rowOffset: 10,
    showTemp: true,
    targetRecipeStepId: "mashOut",
  },
  {
    key: "restLt",
    label: "מנוחה L.T.",
    rowOffset: 12,
    defaultMinutes: 10,
  },
  {
    key: "circulation",
    label: "סחרור L.T.",
    rowOffset: 14,
    defaultMinutes: 10,
  },
  {
    key: "outToBoil",
    label: "הוצאה לבישול",
    rowOffset: 15,
    showEnd: false,
  },
];

const END_TRANSFER_STAGE: StageDef = {
  key: "endTransfer",
  label: "סוף העברה",
  rowOffset: 26,
  showEnd: false,
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

function normalizeUserTime(value: string): string | null {
  const text = value.trim().replace(".", ":");
  if (!text) return "";

  const compact = /^(\d{3,4})$/.exec(text);
  const candidate = compact
    ? `${compact[1].slice(0, -2)}:${compact[1].slice(-2)}`
    : text;

  const match = /^(\d{1,2}):(\d{2})$/.exec(candidate);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedTime(value: unknown): string {
  const text = String(value ?? "").trim();
  const match = text.match(
    /(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?(?:\s|$)/i,
  );
  if (!match) return "";

  let hour = Number(match[1]);
  const suffix = String(match[3] || "").toUpperCase();
  if (suffix === "PM" && hour < 12) hour += 12;
  if (suffix === "AM" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function numericText(value: unknown): string {
  const text = String(value ?? "").replace(",", ".").trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function sheetCell(
  rows: string[][],
  rowOffset: number,
  column: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H",
): string {
  const columnIndex = {
    A: 0,
    B: 1,
    C: 2,
    D: 3,
    E: 4,
    F: 5,
    G: 6,
    H: 7,
  }[column];
  return String(rows[rowOffset]?.[columnIndex] ?? "").trim();
}

function fieldsFromSheetRows(
  rows: string[][],
  usesGrant: boolean,
): Record<string, string> {
  const pulled: Record<string, string> = {};

  TIMELINE_STAGES.forEach((stage) => {
    const start = normalizedTime(sheetCell(rows, stage.rowOffset, "E"));
    const end = normalizedTime(sheetCell(rows, stage.rowOffset, "F"));
    const temp = numericText(sheetCell(rows, stage.rowOffset, "G"));
    if (start) pulled[`${stage.key}.start`] = start;
    if (end) pulled[`${stage.key}.end`] = end;
    if (stage.showTemp && temp) pulled[`${stage.key}.temp`] = temp;

    if (stage.showNote && stage.key !== "mashIn") {
      const note = sheetCell(rows, stage.rowOffset, "H");
      if (note) pulled[`${stage.key}.note`] = note;
    }
  });

  const hltAmount = sheetCell(rows, 8, "B");
  const hltTemp = numericText(sheetCell(rows, 8, "C"));
  const mashInWaterAmount = sheetCell(rows, 9, "B");
  const mashInWaterTemp = sheetCell(rows, 9, "C");
  if (hltAmount) pulled.hltWaterAmount = hltAmount;
  if (hltTemp) pulled.hltWaterTemp = hltTemp;
  if (mashInWaterAmount) pulled.lauterWaterAmount = mashInWaterAmount;
  if (mashInWaterTemp) pulled.lauterWaterTemp = mashInWaterTemp;

  if (!pulled["transferLt.start"] && pulled["heat2.end"]) {
    pulled["transferLt.start"] = pulled["heat2.end"];
  }

  const mashMeta = sheetCell(rows, 0, "H");
  const mashVolume =
    mashMeta.match(/נפח\s*מאש\s*([\d.,]+)/i)?.[1] || "";
  const mashPh =
    mashMeta.match(/pH\s*([\d.,]+)/i)?.[1] || "";
  if (mashVolume) pulled.mashVolume = mashVolume.replace(",", ".");
  if (mashPh) pulled.mashPh = mashPh.replace(",", ".");
  const mashInNote =
    mashMeta.match(/הערה:\s*(.+)$/i)?.[1]?.trim() || "";
  if (mashInNote) pulled["mashIn.note"] = mashInNote;

  const mashAcid = numericText(sheetCell(rows, 28, "A"));
  if (mashAcid) pulled.mashAcid85 = mashAcid;

  const outToBoilPh = numericText(sheetCell(rows, 15, "H"));
  if (outToBoilPh) pulled.outToBoilPh = outToBoilPh;

  const boilCell = sheetCell(rows, 28, "F");
  if (!normalizedTime(boilCell)) {
    const boilPh = numericText(boilCell);
    if (boilPh) pulled.boilPh = boilPh;
  }

  const outToFermentorPh = numericText(sheetCell(rows, 40, "H"));
  if (outToFermentorPh) pulled.outToFermentorPh = outToFermentorPh;

  for (let index = 1; index <= 7; index += 1) {
    const rowOffset = 18 + (index - 1);
    const time = normalizedTime(sheetCell(rows, rowOffset, "E"));
    const amount = numericText(sheetCell(rows, rowOffset, "F"));
    const temp = numericText(sheetCell(rows, rowOffset, "G"));
    const volumeText = sheetCell(rows, rowOffset, "H");

    if (time) pulled[`rinse${index}.time`] = time;
    if (amount) pulled[`rinse${index}.amount`] = amount;
    if (temp) pulled[`rinse${index}.temp`] = temp;

    if (volumeText) {
      const parts = volumeText
        .split("+")
        .map((part) => numericText(part))
        .filter(Boolean);
      if (parts[0]) pulled[`rinse${index}.kettle`] = parts[0];
      if (usesGrant && parts[1]) {
        pulled[`rinse${index}.grant`] = parts[1];
      }
    }
  }

  const sugarFields: Array<
    [string, number, "B" | "C"]
  > = [
    ["frPlato", 36, "B"],
    ["lrPlato", 37, "B"],
    ["kettlePlato", 38, "B"],
    ["kettleVolume", 38, "C"],
    ["endBoilPlato", 39, "B"],
    ["endBoilVolume", 39, "C"],
    ["fermentorSamplePlato", 40, "B"],
    ["cumulativeTankVolume", 40, "C"],
  ];

  sugarFields.forEach(([key, rowOffset, column]) => {
    const value = numericText(sheetCell(rows, rowOffset, column));
    if (value) pulled[key] = value;
  });

  return pulled;
}

export default function BrewFormStepper({ run, recipe, onClose }: Props) {
  const [execution, setExecution] = useState<BrewExecution>(() =>
    loadSandboxExecution(run.batchNumber),
  );
  const [activeStep, setActiveStep] = useState(0);
  const [syncing, setSyncing] = useState("");
  const [pulling, setPulling] = useState(false);
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

  function hasField(key: string): boolean {
    return String(fields[key] ?? "").trim() !== "";
  }

  function stepMissingCount(stepId: StepId): number {
    if (stepId === "water") {
      return [
        "hltWaterAmount",
        "hltWaterTemp",
        "lauterWaterAmount",
        "lauterWaterTemp",
      ].filter((key) => !hasField(key)).length;
    }

    if (stepId === "mash") {
      const required = ["mashVolume", "mashPh"];
      MASH_STAGES.forEach((stage) => {
        required.push(
          `${stage.key}.start`,
          `${stage.key}.end`,
        );
        if (stage.showTemp) required.push(`${stage.key}.temp`);
      });
      return required.filter((key) => !hasField(key)).length;
    }

    if (stepId === "lautering") {
      const required = [
        "transferLt.start",
        "transferLt.end",
        "restLt.start",
        "restLt.end",
        "circulation.start",
        "circulation.end",
        "outToBoil.start",
        "outToBoilPh",
        "endTransfer.start",
        "rinse1.time",
        "rinse1.temp",
        "rinse1.kettle",
      ];
      if (recipe.lautering.usesGrant) required.push("rinse1.grant");
      return required.filter((key) => !hasField(key)).length;
    }

    if (stepId === "boil") {
      const required = ["boil.start", "boilPh"];
      const brewHopCount = Math.min(
        3,
        recipe.hops.filter((hop) => hop.purpose !== "dryHop").length,
      );
      for (let index = 1; index <= brewHopCount; index += 1) {
        required.push(`hop${index}.start`);
      }
      return required.filter((key) => !hasField(key)).length;
    }

    if (stepId === "transfer") {
      return [
        "wp.start",
        "outToFermentor.start",
        "endBoilPlato",
        "endBoilVolume",
        "cumulativeTankVolume",
        "outToFermentorPh",
      ].filter((key) => !hasField(key)).length;
    }

    return (["water", "mash", "lautering", "boil", "transfer"] as StepId[])
      .reduce((sum, id) => sum + stepMissingCount(id), 0);
  }

  function isStepComplete(stepId: StepId): boolean {
    return stepMissingCount(stepId) === 0;
  }

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
    if (Number.isFinite(stage.defaultMinutes) && Number(stage.defaultMinutes) > 0) {
      return Number(stage.defaultMinutes);
    }
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
    if (field === "end") {
      let nextExecution = setSandboxExecutionField(
        execution,
        currentBlock,
        `${stage.key}.end`,
        value,
      );
      const writes: Array<{
        range: string;
        value: string | number | boolean | null;
      }> = [
        {
          range: stageCell(stage.rowOffset, "F"),
          value,
        },
      ];

      let nextStage = nextTimelineStage(stage);
      let nextStart = value;

      while (nextStage) {
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          `${nextStage.key}.start`,
          nextStart,
        );
        writes.push({
          range: stageCell(nextStage.rowOffset, "E"),
          value: nextStart,
        });

        const duration = knownDuration(nextStage);
        if (!nextStart || duration === null) break;

        const calculatedEnd = addMinutesToTime(nextStart, duration);
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          `${nextStage.key}.end`,
          calculatedEnd,
        );
        writes.push({
          range: stageCell(nextStage.rowOffset, "F"),
          value: calculatedEnd,
        });

        nextStart = calculatedEnd;
        nextStage = nextTimelineStage(nextStage);
      }

      setExecution(nextExecution);
      await writeSheet(`${stage.key}.end`, writes);
      return;
    }

    const cellValue = value ? `${value}°C` : value;
    await commit(`${stage.key}.temp`, value, [
      { range: stageCell(stage.rowOffset, "G"), value: cellValue },
    ]);
  }

  function mashMetaText(nextFields: Record<string, string>) {
    return [
      nextFields.mashVolume
        ? `נפח מאש ${nextFields.mashVolume}`
        : "",
      nextFields.mashPh ? `pH ${nextFields.mashPh}` : "",
      nextFields["mashIn.note"]
        ? `הערה: ${nextFields["mashIn.note"]}`
        : "",
    ]
      .filter(Boolean)
      .join("   ");
  }

  async function commitStageNote(stage: StageDef, value: string) {
    const key = `${stage.key}.note`;
    if (stage.key === "mashIn") {
      const nextFields = { ...fields, [key]: value };
      await commit(key, value, [
        {
          range: stageCell(0, "H"),
          value: mashMetaText(nextFields),
        },
      ]);
      return;
    }

    await commit(key, value, [
      { range: stageCell(stage.rowOffset, "H"), value },
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
    await commit(field, value, [
      {
        range: stageCell(0, "H"),
        value: mashMetaText(nextFields),
      },
    ]);
  }

  async function commitMashAcid(value: string) {
    await commit("mashAcid85", value, [
      {
        range: `'גיליון1'!A${baseRow + 28}`,
        value: num(value) ?? value,
      },
    ]);
  }

  async function commitWaterField(
    field:
      | "hltWaterAmount"
      | "hltWaterTemp"
      | "lauterWaterAmount"
      | "lauterWaterTemp",
    value: string,
  ) {
    const mapping = {
      hltWaterAmount: { rowOffset: 8, column: "B" },
      hltWaterTemp: { rowOffset: 8, column: "C" },
      lauterWaterAmount: { rowOffset: 9, column: "B" },
      lauterWaterTemp: { rowOffset: 9, column: "C" },
    } as const;
    const target = mapping[field];
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [
      {
        range: `'גיליון1'!${target.column}${baseRow + target.rowOffset}`,
        value:
          field.endsWith("Temp") && value
            ? num(value) ?? value
            : value,
      },
    ];

    // Preview versions before this fix wrote the second water row into
    // "שטיפות". Clear that stale value when the corrected MASH IN field is saved.
    if (field === "lauterWaterAmount") {
      writes.push({
        range: `'גיליון1'!B${baseRow + 11}`,
        value: "",
      });
    } else if (field === "lauterWaterTemp") {
      writes.push({
        range: `'גיליון1'!C${baseRow + 11}`,
        value: "",
      });
    }

    await commit(field, value, writes);
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
      let nextExecution = setSandboxExecutionField(
        execution,
        currentBlock,
        key,
        value,
      );
      const writes: Array<{
        range: string;
        value: string | number | boolean | null;
      }> = [{ range: stageCell(rowOffset, "E"), value }];

      const amountKey = `rinse${index}.amount`;
      if (!String(fields[amountKey] || "").trim()) {
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          amountKey,
          "150",
        );
        writes.push({
          range: stageCell(rowOffset, "F"),
          value: 150,
        });
      }

      setExecution(nextExecution);
      await writeSheet(key, writes);
      return;
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

  async function syncFromSheet() {
    if (!run.sheetId) return;

    setPulling(true);
    setMessage("");

    try {
      let nextExecution = execution;

      for (let index = 1; index <= totalBlocks; index += 1) {
        const row = blockBaseRow(run.tankType, index);
        const rows = await readSandboxSheetRange(
          run.sheetId,
          `'גיליון1'!A${row}:H${row + 40}`,
        );
        const pulled = fieldsFromSheetRows(
          rows,
          recipe.lautering.usesGrant,
        );
        const existing =
          nextExecution.blocks[String(index)]?.fields || {};
        nextExecution = replaceSandboxExecutionBlockFields(
          nextExecution,
          index,
          {
            ...existing,
            ...pulled,
          },
        );
      }

      setExecution(nextExecution);
      setMessage("✓ הנתונים סונכרנו עכשיו מה-Sheet.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "סנכרון הנתונים מה-Sheet נכשל.",
      );
    } finally {
      setPulling(false);
    }
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

  async function commitTypedStageTime(
    stage: StageDef,
    field: "start" | "end",
    raw: string,
  ) {
    const normalized = normalizeUserTime(raw);
    if (normalized === null) {
      setMessage("יש להזין שעה בפורמט 24 שעות, למשל 08:22 או 1845.");
      return;
    }

    setMessage("");
    setLocal(`${stage.key}.${field}`, normalized);
    if (field === "start") {
      await commitStageStart(stage, normalized);
    } else {
      await commitStage(stage, "end", normalized);
    }
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
          const showEnd = stage.showEnd !== false;

          return (
            <div
              className={[
                "brew-stage-row",
                !showEnd ? "brew-stage-row-no-end" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={stage.key}
            >
              <div className="brew-stage-label">
                <strong>{stage.label}</strong>
                {target && (
                  <small>
                    יעד {target.targetTemp}°C
                    {duration ? ` · ${duration} דק׳` : ""}
                  </small>
                )}
                {!target && duration && (
                  <small>{duration} דק׳</small>
                )}
              </div>

              <label>
                התחלה
                <div className="brew-time-input">
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="HH:MM"
                    value={localValue(`${stage.key}.start`)}
                    onChange={(e) =>
                      setLocal(`${stage.key}.start`, e.target.value)
                    }
                    onBlur={(e) =>
                      void commitTypedStageTime(
                        stage,
                        "start",
                        e.target.value,
                      )
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

              {showEnd && (
                <label>
                  סיום
                  <div className="brew-time-input">
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="HH:MM"
                      value={localValue(`${stage.key}.end`)}
                      onChange={(e) =>
                        setLocal(`${stage.key}.end`, e.target.value)
                      }
                      onBlur={(e) =>
                        void commitTypedStageTime(
                          stage,
                          "end",
                          e.target.value,
                        )
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
              )}

              {stage.showTemp && (
                <label>
                  טמפ׳
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

              {stage.key === "outToBoil" && (
                <label>
                  pH
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
              )}

              {stage.showNote && (
                <label className="brew-stage-note">
                  הערה
                  <input
                    value={localValue(`${stage.key}.note`)}
                    onChange={(e) =>
                      setLocal(`${stage.key}.note`, e.target.value)
                    }
                    onBlur={(e) =>
                      void commitStageNote(stage, e.target.value)
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
            className="brew-back-button brew-button-secondary"
            onClick={onClose}
          >
            חזרה לאצוות
          </button>
          <h2>
            אצווה {run.batchNumber} · {run.style} · מיכל {run.tankNumber}
          </h2>
          <div className="brew-sync-line">
            <span>
              בישול {currentBlock}/{totalBlocks} · מתכון v{recipe.version}
            </span>
            {syncing ? (
              <BeerLoader size="spinner" message="שומר ל-Sheet…" />
            ) : pulling ? (
              <BeerLoader size="spinner" message="קורא מה-Sheet…" />
            ) : (
              <span className="brew-sync-ok">✓ מסונכרן</span>
            )}
          </div>
        </div>

        <button
          type="button"
          className="brew-button-secondary brew-sync-now"
          disabled={pulling || !!syncing || !run.sheetId}
          onClick={() => void syncFromSheet()}
        >
          ↻ סנכרן עכשיו
        </button>
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
        {STEPS.map((step, index) => {
          const complete = isStepComplete(step.id);
          const missing = stepMissingCount(step.id);

          return (
            <button
              type="button"
              key={step.id}
              className={[
                index === activeStep ? "active" : "",
                complete ? "complete" : "warning",
              ]
                .filter(Boolean)
                .join(" ")}
              title={
                complete
                  ? `${step.label}: הושלם`
                  : `${step.label}: חסרים ${missing} נתונים`
              }
              onClick={() => setActiveStep(index)}
            >
              <span aria-hidden="true">{complete ? "✓" : "!"}</span>
              <strong>{step.label}</strong>
            </button>
          );
        })}
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

        {currentStep.id === "water" && (
          <div className="brew-water-grid">
            <article className="brew-water-card">
              <div>
                <strong>HLT</strong>
                <small>מצב המים בתחילת הבישול</small>
              </div>
              <label>
                כמות מים
                <input
                  value={localValue("hltWaterAmount")}
                  onChange={(e) =>
                    setLocal("hltWaterAmount", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitWaterField(
                      "hltWaterAmount",
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                טמפ׳ °C
                <input
                  type="number"
                  step="0.1"
                  value={localValue("hltWaterTemp")}
                  onChange={(e) =>
                    setLocal("hltWaterTemp", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitWaterField(
                      "hltWaterTemp",
                      e.target.value,
                    )
                  }
                />
              </label>
            </article>

            <article className="brew-water-card">
              <div>
                <strong>MASH IN / מי מאש</strong>
              </div>
              <label>
                כמות מים
                <input
                  value={localValue("lauterWaterAmount")}
                  onChange={(e) =>
                    setLocal("lauterWaterAmount", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitWaterField(
                      "lauterWaterAmount",
                      e.target.value,
                    )
                  }
                />
              </label>
              <label>
                טמפ׳ °C
                <input
                  type="number"
                  step="0.1"
                  value={localValue("lauterWaterTemp")}
                  onChange={(e) =>
                    setLocal("lauterWaterTemp", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitWaterField(
                      "lauterWaterTemp",
                      e.target.value,
                    )
                  }
                />
              </label>
            </article>
          </div>
        )}

        {currentStep.id === "mash" && (
          <>
            <div className="brew-section-title">
              <span>מי מאש יעד: {recipe.mash.waterLiters} ל׳</span>
            </div>

            {renderStageRows([MASH_STAGES[0]])}

            <div className="brew-mash-meta-row">
              <label>
                נפח מאש
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

              <label>
                כמות H3PO4 85% (ML)
                <input
                  type="number"
                  step="0.1"
                  value={localValue("mashAcid85")}
                  onChange={(e) =>
                    setLocal("mashAcid85", e.target.value)
                  }
                  onBlur={(e) =>
                    void commitMashAcid(e.target.value)
                  }
                />
              </label>
            </div>

            {renderStageRows(MASH_STAGES.slice(1))}
          </>
        )}

        {currentStep.id === "lautering" && (
          <>
            <div className="brew-lauter-mashout-context">
              <div>
                <span>חימום למאש אווט</span>
                <strong>
                  {localValue("heat2.start") || "—"}–{localValue("heat2.end") || "—"}
                </strong>
              </div>
              <small>
                יעד{" "}
                {recipe.mash.steps.find((step) => step.id === "mashOut")
                  ?.targetTemp ?? "—"}
                °C · התצוגה מגיעה משלב המאש ואינה ניתנת לעריכה כאן
              </small>
            </div>

            {renderStageRows(LAUTER_STAGES)}

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
                      <div className="brew-time-input">
                        <input
                          type="text"
                          inputMode="numeric"
                          dir="ltr"
                          placeholder="HH:MM"
                          value={localValue(`rinse${index}.time`)}
                          onChange={(e) =>
                            setLocal(
                              `rinse${index}.time`,
                              e.target.value,
                            )
                          }
                          onBlur={(e) => {
                            const value = normalizeUserTime(e.target.value);
                            if (value === null) {
                              setMessage(
                                "יש להזין שעה בפורמט 24 שעות, למשל 08:22 או 1845.",
                              );
                              return;
                            }
                            setLocal(`rinse${index}.time`, value);
                            void commitRinse(index, "time", value);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            void commitRinse(index, "time", hhmmNow())
                          }
                        >
                          עכשיו
                        </button>
                      </div>
                    </label>

                    <label>
                      ליטר
                      <input
                        type="number"
                        value={localValue(`rinse${index}.amount`) || "150"}
                        onFocus={(e) => e.currentTarget.select()}
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
                  <h4>מחשבון נפח רתיחה</h4>
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
                  <span>נפח יעד</span>
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

            <div className="brew-summary-sync">
              <button
                type="button"
                className="brew-button-secondary"
                disabled={pulling || !!syncing || !run.sheetId}
                onClick={() => void syncFromSheet()}
              >
                {pulling ? (
                  <BeerLoader size="spinner" message="מסנכרן…" />
                ) : (
                  "↻ סנכרן עכשיו מה-Sheet"
                )}
              </button>
              <small>
                מושך שינויים שנעשו ידנית ב-Sheet אל טופס הבישול.
              </small>
            </div>
          </div>
        )}
      </section>

      <div className="brew-step-footer">
        <button
          type="button"
          className="brew-button-secondary"
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
          className="btn-primary brew-button-primary"
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
