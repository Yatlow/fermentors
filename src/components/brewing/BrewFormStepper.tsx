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
import { loadSandboxIngredients } from "../../SERVICES/brewing/sandboxIngredients";
import {
  activeLot,
  type IngredientDefinition,
  type IngredientLot,
} from "../../SERVICES/brewing/ingredientLibrary";
import {
  loadMashAcidHistoryPreview,
  type MashAcidHistoryRow,
} from "../../SERVICES/brewing/mashAcidHistory";

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

type SyncMismatch = {
  blockIndex: number;
  key: string;
  label: string;
  appValue: string;
  sheetValue: string;
};

type StepId =
  | "water"
  | "mash"
  | "lautering"
  | "boil"
  | "transfer"
  | "summary";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "water", label: "תאריך, מים וחומרי גלם" },
  { id: "mash", label: "מאש" },
  { id: "lautering", label: "לאוטר" },
  { id: "boil", label: "רתיחה וכשות" },
  { id: "transfer", label: "WP והוצאה לתסיסה" },
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
  { key: "boil", label: "תחילת רתיחה", rowOffset: 28, showEnd: false },
  { key: "hop1", label: "הוספת כשות 1", rowOffset: 30, showEnd: false },
  { key: "hop2", label: "הוספת כשות 2", rowOffset: 32, showEnd: false },
  { key: "hop3", label: "הוספת כשות 3", rowOffset: 34, showEnd: false },
];

const WP_STAGE: StageDef = {
  key: "wp",
  label: "WP",
  rowOffset: 38,
  defaultMinutes: 20,
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

function blockHeaderRow(
  tankType: SandboxBrewRun["tankType"],
  blockIndex: number,
): number {
  const rows =
    tankType === "single"
      ? [4]
      : tankType === "double"
        ? [4, 54]
        : [4, 54, 102];
  return rows[blockIndex - 1] || rows[0];
}

function fermentationStartingRow(
  tankType: SandboxBrewRun["tankType"],
): number {
  return tankType === "single" ? 59 : tankType === "double" ? 106 : 156;
}

function isoDateFromSheet(value: string): string {
  const text = String(value || "").trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function sheetDateFromIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function syncTimeLabel(value: Date | null): string {
  if (!value) return "טרם";
  return value.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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

  const boilAcid = numericText(sheetCell(rows, 29, "A"));
  if (boilAcid) pulled.boilAcid85 = boilAcid;

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

  for (let index = 1; index <= 3; index += 1) {
    const amount = numericText(sheetCell(rows, 14 + index, "A"));
    if (amount) pulled[`hop${index}.amountGrams`] = amount;
  }

  if (pulled["wp.start"]) pulled.endBoilTime = pulled["wp.start"];

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
  const [acidHistoryMode, setAcidHistoryMode] =
    useState<"mash" | "boil" | null>(null);
  const [acidHistoryLoading, setAcidHistoryLoading] = useState(false);
  const [acidHistoryError, setAcidHistoryError] = useState("");
  const [acidHistory, setAcidHistory] = useState<MashAcidHistoryRow[]>([]);
  const [boilCalcOpen, setBoilCalcOpen] = useState(false);
  const [lastPushAt, setLastPushAt] = useState<Date | null>(null);
  const [lastPullAt, setLastPullAt] = useState<Date | null>(null);
  const [lastVerifyAt, setLastVerifyAt] = useState<Date | null>(null);
  const [checkingSync, setCheckingSync] = useState(false);
  const [syncMismatchCount, setSyncMismatchCount] = useState<number | null>(null);
  const [syncMismatches, setSyncMismatches] = useState<SyncMismatch[]>([]);
  const [syncError, setSyncError] = useState("");
  const [heightCalcOpen, setHeightCalcOpen] = useState(false);
  const [heightCm, setHeightCm] = useState("");
  const ingredientLibrary = useMemo(
    () => loadSandboxIngredients(),
    [],
  );

  const totalBlocks = getBlockCount(run.tankType);
  const currentBlock = Math.min(
    Math.max(execution.activeBlockIndex || 1, 1),
    totalBlocks,
  );
  const fields = execution.blocks[String(currentBlock)]?.fields || {};
  const baseRow = blockBaseRow(run.tankType, currentBlock);
  const visibleSteps =
    currentBlock === totalBlocks
      ? STEPS
      : STEPS.filter((step) => step.id !== "summary");
  const currentStep = visibleSteps[Math.min(activeStep, visibleSteps.length - 1)];

  const brewMaterials = useMemo(() => {
    const ids = [
      ...recipe.grains.map((item) => item.ingredientId),
      ...recipe.hops
        .filter((item) => item.purpose !== "dryHop")
        .map((item) => item.ingredientId),
      recipe.yeast.ingredientId,
    ].filter(Boolean);

    return Array.from(new Set(ids))
      .map((id) => ingredientLibrary.find((item) => item.id === id))
      .filter((item): item is IngredientDefinition => !!item);
  }, [recipe, ingredientLibrary]);

  const boilHops = useMemo(
    () => recipe.hops.filter((hop) => hop.purpose !== "dryHop").slice(0, 3),
    [recipe.hops],
  );

  const totalBoilMinutes = useMemo(() => {
    const values = boilHops
      .map((hop) => Number(hop.boilMinutes))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return values.length ? Math.max(...values) : 60;
  }, [boilHops]);

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
    const evaporationFactor = num(fields.boilEvaporationFactor || "100");
    if (
      volume === null ||
      plato === null ||
      evaporationFactor === null ||
      !recipe.targets.endBoilPlato
    ) {
      return null;
    }
    return (
      (volume * plato) / recipe.targets.endBoilPlato +
      evaporationFactor
    );
  }, [
    fields.boilSampleVolume,
    fields.boilSamplePlato,
    fields.boilEvaporationFactor,
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

    const hasTime =
      String(fields[`rinse${highestWithData}.time`] || "").trim() !== "";

    return Math.min(7, hasTime ? highestWithData + 1 : highestWithData);
  }, [fields]);

  const missingItems = useMemo(() => {
    const labels: Array<[StepId, string]> = [
      ["water", "תאריך, מים וחומרי גלם"],
      ["mash", "מאש"],
      ["lautering", "לאוטר"],
      ["boil", "רתיחה וכשות"],
      ["transfer", "WP והוצאה לתסיסה"],
    ];
    return labels
      .map(([id, label]) => ({
        label,
        count: stepMissingCountForBlock(currentBlock, id),
      }))
      .filter((item) => item.count > 0);
  }, [
    execution.blocks,
    currentBlock,
    boilHops.length,
    recipe.lautering.usesGrant,
  ]);

  function blockFields(blockIndex: number): Record<string, string> {
    return execution.blocks[String(blockIndex)]?.fields || {};
  }

  function hasFieldForBlock(blockIndex: number, key: string): boolean {
    return String(blockFields(blockIndex)[key] ?? "").trim() !== "";
  }

  function hasField(key: string): boolean {
    return hasFieldForBlock(currentBlock, key);
  }

  function stepMissingCountForBlock(
    blockIndex: number,
    stepId: StepId,
  ): number {
    const has = (key: string) => hasFieldForBlock(blockIndex, key);

    if (stepId === "water") {
      return [
        "brewDate",
        "hltWaterAmount",
        "hltWaterTemp",
        "lauterWaterAmount",
        "lauterWaterTemp",
        "materialsConfirmed",
      ].filter((key) => !has(key)).length;
    }

    if (stepId === "mash") {
      const required = ["mashVolume", "mashPh", "mashAcid85"];
      MASH_STAGES.forEach((stage) => {
        required.push(`${stage.key}.start`, `${stage.key}.end`);
        if (stage.showTemp) required.push(`${stage.key}.temp`);
      });
      return required.filter((key) => !has(key)).length;
    }

    if (stepId === "lautering") {
      const required = [
        "transferLt.start",
        "transferLt.end",
        "transferLt.temp",
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
      return required.filter((key) => !has(key)).length;
    }

    if (stepId === "boil") {
      const required = [
        "boil.start",
        "boilPh",
        "boilAcid85",
        "kettlePlato",
        "kettleVolume",
        "endBoilTime",
      ];
      for (let index = 1; index <= boilHops.length; index += 1) {
        required.push(`hop${index}.start`, `hop${index}.amountGrams`);
      }
      return required.filter((key) => !has(key)).length;
    }

    if (stepId === "transfer") {
      const required = [
        "wp.start",
        "wp.end",
        "outToFermentor.start",
        "outToFermentor.end",
        "endBoilPlato",
        "endBoilVolume",
        "fermentorSamplePlato",
        "cumulativeTankVolume",
        "outToFermentorPh",
      ];
      if (blockIndex === 1) required.push("yeastPitchTime");
      return required.filter((key) => !has(key)).length;
    }

    return (["water", "mash", "lautering", "boil", "transfer"] as StepId[])
      .reduce(
        (sum, id) => sum + stepMissingCountForBlock(blockIndex, id),
        0,
      );
  }

  function stepMissingCount(stepId: StepId): number {
    return stepMissingCountForBlock(currentBlock, stepId);
  }

  function blockMissingCount(blockIndex: number): number {
    return (["water", "mash", "lautering", "boil", "transfer"] as StepId[])
      .reduce(
        (sum, id) => sum + stepMissingCountForBlock(blockIndex, id),
        0,
      );
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
      setLastPushAt(new Date());
      setSyncMismatchCount(null);
      setSyncMismatches([]);
      setSyncError("");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "שמירת הנתון ב-Sheet נכשלה.";
      setSyncError(detail);
      setMessage(detail);
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

  function selectedMaterialLot(
    ingredient: IngredientDefinition,
  ): IngredientLot | undefined {
    const selectedId = localValue(`materialLot.${ingredient.id}`);
    return (
      ingredient.lots.find((lot) => lot.id === selectedId) ||
      activeLot(ingredient) ||
      ingredient.lots[0]
    );
  }

  function selectMaterialLot(ingredientId: string, lotId: string) {
    let next = setSandboxExecutionField(
      execution,
      currentBlock,
      `materialLot.${ingredientId}`,
      lotId,
    );
    next = setSandboxExecutionField(
      next,
      currentBlock,
      "materialsConfirmed",
      "",
    );

    const hopIndex = boilHops.findIndex(
      (hop) => hop.ingredientId === ingredientId,
    );
    if (hopIndex >= 0) {
      next = setSandboxExecutionField(
        next,
        currentBlock,
        `hop${hopIndex + 1}.amountGrams`,
        "",
      );
    }

    setExecution(next);
  }

  async function commitBrewDate(value: string) {
    const headerRow = blockHeaderRow(run.tankType, currentBlock);
    const display = sheetDateFromIso(value);
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [
      {
        range: `'גיליון1'!H${headerRow}`,
        value: display,
      },
    ];

    if (currentBlock === 1) {
      writes.push(
        { range: "'גיליון1'!H1", value: display },
        {
          range: `'גיליון1'!B${fermentationStartingRow(run.tankType)}`,
          value: display,
        },
      );
    }

    await commit("brewDate", value, writes);
  }

  async function confirmMaterials() {
    let nextExecution = execution;
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [];

    recipe.grains.forEach((grain, index) => {
      const ingredient = ingredientLibrary.find(
        (item) => item.id === grain.ingredientId,
      );
      if (!ingredient) return;
      const lot = selectedMaterialLot(ingredient);
      if (!lot) return;

      nextExecution = setSandboxExecutionField(
        nextExecution,
        currentBlock,
        `materialLot.${ingredient.id}`,
        lot.id,
      );
      const row = baseRow + index;
      const typeAndLot = [
        ingredient.name,
        lot.lotNumber ? `#${lot.lotNumber}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      writes.push(
        { range: `'גיליון1'!B${row}`, value: typeAndLot },
        { range: `'גיליון1'!C${row}`, value: lot.supplier || "" },
      );
    });

    recipe.hops
      .filter((hop) => hop.purpose !== "dryHop")
      .forEach((hop, index) => {
        const ingredient = ingredientLibrary.find(
          (item) => item.id === hop.ingredientId,
        );
        if (!ingredient) return;
        const lot = selectedMaterialLot(ingredient);
        if (!lot) return;

        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          `materialLot.${ingredient.id}`,
          lot.id,
        );
        const row = baseRow + 15 + index;
        writes.push({
          range: `'גיליון1'!C${row}`,
          value: `${index + 1})${ingredient.name}${lot.lotNumber ? ` ${lot.lotNumber}` : ""}`,
        });
        if (lot.alpha !== undefined) {
          writes.push({
            range: `'גיליון1'!B${row}`,
            value: Number(lot.alpha),
          });
        }

        const amountKey = `hop${index + 1}.amountGrams`;
        if (!String(fields[amountKey] || "").trim()) {
          const dose = hopDose(hop);
          if (dose.grams !== null) {
            const grams = String(Math.round(dose.grams));
            nextExecution = setSandboxExecutionField(
              nextExecution,
              currentBlock,
              amountKey,
              grams,
            );
            writes.push({
              range: `'גיליון1'!A${row}`,
              value: Number(grams),
            });
          }
        }
      });

    const yeast = ingredientLibrary.find(
      (item) => item.id === recipe.yeast.ingredientId,
    );
    if (yeast) {
      const lot = selectedMaterialLot(yeast);
      if (lot) {
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          `materialLot.${yeast.id}`,
          lot.id,
        );
        const row = baseRow + 23;
        writes.push(
          { range: `'גיליון1'!B${row}`, value: yeast.name },
          {
            range: `'גיליון1'!C${row}`,
            value: [lot.lotNumber, lot.supplier].filter(Boolean).join(" · "),
          },
        );
      }
    }

    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "materialsConfirmed",
      "yes",
    );
    setExecution(nextExecution);
    await writeSheet("materialsConfirmed", writes);
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

    if (stage.key === "transferLt" && !String(fields["transferLt.temp"] || "").trim()) {
      nextExecution = setSandboxExecutionField(
        nextExecution,
        currentBlock,
        "transferLt.temp",
        "77.5",
      );
      writes.push({
        range: stageCell(stage.rowOffset, "G"),
        value: "77.5°C",
      });
    }

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

  function approveNumericValue(key: string, value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true;

    const parsed = num(trimmed);
    if (parsed === null) {
      setMessage("הערך חייב להיות מספר.");
      return false;
    }

    let hardError = "";
    let warning = "";

    if (/Ph$/i.test(key) || key === "mashPh" || key === "boilPh") {
      if (parsed < 4 || parsed > 7) {
        hardError = `pH ${parsed} אינו ערך סביר לבישול (טווח קשיח 4–7).`;
      } else if (parsed < 5 || parsed > 6.2) {
        warning = `pH ${parsed} חריג ביחס לבישולים האחרונים (רובם סביב 5.45–5.85).`;
      }
    } else if (key === "mashAcid85" || key === "boilAcid85") {
      if (parsed < 0 || parsed > 300) {
        hardError = `כמות חומצה ${parsed} מ״ל אינה סבירה (0–300 מ״ל).`;
      }
    } else if (
      key === "frPlato" ||
      key === "lrPlato" ||
      key === "kettlePlato" ||
      key === "endBoilPlato" ||
      key === "fermentorSamplePlato"
    ) {
      if (parsed < 3 || parsed > 30) {
        hardError = `Plato ${parsed} אינו סביר (טווח קשיח 3–30°P).`;
      } else if (
        ["kettlePlato", "endBoilPlato", "fermentorSamplePlato"].includes(key) &&
        recipe.targets.endBoilPlato > 0 &&
        Math.abs(parsed - recipe.targets.endBoilPlato) > 3
      ) {
        warning = `הערך ${parsed}°P רחוק ביותר מ-3°P מיעד סוף הרתיחה ${recipe.targets.endBoilPlato}°P.`;
      }

      if (
        key === "fermentorSamplePlato" &&
        num(fields.endBoilPlato || "") !== null &&
        Math.abs(parsed - Number(fields.endBoilPlato)) > 1
      ) {
        warning = `Plato ביציאה לתסיסה שונה ביותר מ-1°P מסוף הרתיחה (${fields.endBoilPlato}°P).`;
      }
    } else if (key === "mashVolume") {
      if (parsed < 500 || parsed > 2000) {
        hardError = `נפח מאש ${parsed} ל׳ אינו סביר (500–2000 ל׳).`;
      } else if (parsed < 700 || parsed > 1700) {
        warning = `נפח מאש ${parsed} ל׳ חריג ביחס להיסטוריה האחרונה.`;
      }
    } else if (key === "kettleVolume" || key === "endBoilVolume") {
      if (parsed < 500 || parsed > 2500) {
        hardError = `נפח ${parsed} ל׳ אינו סביר (500–2500 ל׳).`;
      } else if (parsed < 900 || parsed > 1900) {
        warning = `נפח ${parsed} ל׳ חריג ביחס לבישולים האחרונים.`;
      }

      if (key === "endBoilVolume") {
        const startVolume = num(fields.kettleVolume || "");
        if (startVolume !== null) {
          const loss = startVolume - parsed;
          if (parsed > startVolume + 50) {
            warning = `נפח סוף רתיחה (${parsed}) גבוה מנפח תחילת הרתיחה (${startVolume}).`;
          } else if (loss > 300 || loss / startVolume > 0.2) {
            warning = `אובדן של ${Math.round(loss)} ל׳ ברתיחה חריג מאוד.`;
          }
        }
      }
    } else if (key === "cumulativeTankVolume") {
      if (parsed < 500 || parsed > 6000) {
        hardError = `נפח מיכל ${parsed} ל׳ אינו סביר (500–6000 ל׳).`;
      }
      if (currentBlock > 1) {
        const previous = num(
          blockFields(currentBlock - 1).cumulativeTankVolume || "",
        );
        if (previous !== null) {
          const added = parsed - previous;
          if (added <= 0) {
            warning = `הנפח המצטבר חייב לגדול לעומת בישול ${["A", "B", "C"][currentBlock - 2]} (${previous} ל׳).`;
          } else if (added < 700 || added > 1700) {
            warning = `תוספת של ${Math.round(added)} ל׳ מהבישול הקודם חריגה (בדרך כלל כ-700–1700 ל׳).`;
          }
        }
      }
    } else if (/^rinse\d+\.(kettle|grant)$/.test(key)) {
      if (parsed < 0 || parsed > 2500) {
        hardError = `נפח שטיפה ${parsed} ל׳ אינו סביר.`;
      }
      const match = /^rinse(\d+)\.kettle$/.exec(key);
      if (match && Number(match[1]) > 1) {
        const previous = num(fields[`rinse${Number(match[1]) - 1}.kettle`] || "");
        if (previous !== null) {
          const jump = parsed - previous;
          if (jump < 0) {
            warning = "נפח ה-Kettle ירד לעומת השטיפה הקודמת.";
          } else if (jump > 500) {
            warning = `קפיצה של ${Math.round(jump)} ל׳ בין שטיפות חריגה.`;
          }
        }
      }
    } else if (/^hop\d+\.amountGrams$/.test(key)) {
      if (parsed < 0 || parsed > 5000) {
        hardError = `כמות כשות ${parsed} גרם אינה סבירה.`;
      }
    } else if (/Temp$/.test(key) || key.endsWith(".temp")) {
      if (parsed < 0 || parsed > 100) {
        hardError = `טמפרטורה ${parsed}°C אינה סבירה.`;
      }
    }

    if (hardError) {
      setMessage(`⚠ ${hardError} הנתון לא נשמר — בדוק שאין TYPO.`);
      return false;
    }

    if (warning) {
      const approved = window.confirm(
        `${warning}\n\nייתכן שהנתון נכון. לשמור אותו בכל זאת?`,
      );
      if (!approved) {
        setMessage("השמירה בוטלה כדי לאפשר תיקון הנתון.");
        return false;
      }
    }

    setMessage("");
    return true;
  }

  async function commitMashMeta(
    field: "mashVolume" | "mashPh",
    value: string,
  ) {
    if (!approveNumericValue(field, value)) return;
    const nextFields = { ...fields, [field]: value };
    await commit(field, value, [
      {
        range: stageCell(0, "H"),
        value: mashMetaText(nextFields),
      },
    ]);
  }

  async function commitMashAcid(value: string) {
    if (!approveNumericValue("mashAcid85", value)) return;
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
    if (!approveNumericValue(key, value)) return;
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
      if (!approveNumericValue(key, value)) return;
      return commit(key, value, [
        {
          range: stageCell(rowOffset, "G"),
          value: value ? `${value}°C` : "",
        },
      ]);
    }

    if (!approveNumericValue(key, value)) return;
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
    if (!approveNumericValue(key, value)) return;
    const parsed = num(value);
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [
      {
        range: `'גיליון1'!${column}${baseRow + rowOffset}`,
        value: parsed === null ? "" : parsed,
      },
    ];

    if (key === "kettleVolume" && parsed !== null) {
      let nextExecution = setSandboxExecutionField(
        execution,
        currentBlock,
        key,
        value,
      );

      boilHops.forEach((hop, index) => {
        const amountKey = `hop${index + 1}.amountGrams`;
        if (String(fields[amountKey] || "").trim()) return;

        const dose = hopDose(hop, parsed);
        if (dose.grams === null) return;

        const grams = String(Math.round(dose.grams));
        nextExecution = setSandboxExecutionField(
          nextExecution,
          currentBlock,
          amountKey,
          grams,
        );
        writes.push({
          range: `'גיליון1'!A${baseRow + 15 + index}`,
          value: Number(grams),
        });
      });

      setExecution(nextExecution);
      await writeSheet(key, writes);
      return;
    }

    await commit(key, value, writes);
  }

  async function commitBoilAcid(value: string) {
    if (!approveNumericValue("boilAcid85", value)) return;
    await commit("boilAcid85", value, [
      {
        range: `'גיליון1'!A${baseRow + 29}`,
        value: num(value) ?? value,
      },
    ]);
  }

  async function commitBoilStart(raw: string) {
    const value = normalizeUserTime(raw);
    if (value === null) {
      setMessage("יש להזין שעה בפורמט 24 שעות, למשל 10:35.");
      return;
    }

    let nextExecution = setSandboxExecutionField(
      execution,
      currentBlock,
      "boil.start",
      value,
    );
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [{ range: stageCell(28, "E"), value }];

    boilHops.forEach((hop, index) => {
      const minutes = Number(hop.boilMinutes ?? 0);
      const offset = Math.max(0, totalBoilMinutes - minutes);
      const time = addMinutesToTime(value, offset);
      nextExecution = setSandboxExecutionField(
        nextExecution,
        currentBlock,
        `hop${index + 1}.start`,
        time,
      );
      writes.push({
        range: stageCell(30 + index * 2, "E"),
        value: time,
      });
    });

    const endBoil = addMinutesToTime(value, totalBoilMinutes);
    const wpEnd = addMinutesToTime(endBoil, 20);
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "endBoilTime",
      endBoil,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "wp.start",
      endBoil,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "wp.end",
      wpEnd,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "outToFermentor.start",
      wpEnd,
    );
    writes.push(
      {
        range: stageCell(38, "E"),
        value: endBoil,
      },
      {
        range: stageCell(38, "F"),
        value: wpEnd,
      },
      {
        range: stageCell(40, "E"),
        value: wpEnd,
      },
    );

    setExecution(nextExecution);
    await writeSheet("boil.start", writes);
  }

  async function commitBoilEvent(
    key: string,
    rowOffset: number,
    raw: string,
  ) {
    const value = normalizeUserTime(raw);
    if (value === null) {
      setMessage("יש להזין שעה בפורמט 24 שעות.");
      return;
    }
    await commit(key, value, [
      { range: stageCell(rowOffset, "E"), value },
    ]);
  }

  function hopDose(
    hop: BrewRecipe["hops"][number],
    kettleVolumeOverride?: number | null,
  ): { grams: number | null; gramsPerLiter: number | null; alpha: number | null } {
    const kettleVolume =
      kettleVolumeOverride === undefined
        ? num(fields.kettleVolume || "")
        : kettleVolumeOverride;
    const ingredient = ingredientLibrary.find(
      (item) => item.id === hop.ingredientId,
    );
    const lot = ingredient ? selectedMaterialLot(ingredient) : undefined;
    const alpha =
      lot?.alpha !== undefined && Number.isFinite(Number(lot.alpha))
        ? Number(lot.alpha)
        : null;

    let gramsPerLiter = Number(hop.gramsPerLiter);
    if (!Number.isFinite(gramsPerLiter) || gramsPerLiter < 0) {
      gramsPerLiter = 0;
    }

    if (
      hop.purpose === "bitterness" &&
      alpha !== null &&
      alpha > 0 &&
      Number.isFinite(Number(hop.aa)) &&
      Number(hop.aa) > 0
    ) {
      gramsPerLiter =
        (gramsPerLiter * Number(hop.aa)) / alpha;
    }

    return {
      grams:
        kettleVolume === null ? null : gramsPerLiter * kettleVolume,
      gramsPerLiter,
      alpha,
    };
  }

  async function commitHopAmount(index: number, value: string) {
    const key = `hop${index + 1}.amountGrams`;
    if (!approveNumericValue(key, value)) return;
    await commit(key, value, [
      {
        range: `'גיליון1'!A${baseRow + 15 + index}`,
        value: num(value) ?? "",
      },
    ]);
  }

  async function commitEndBoil(raw: string) {
    const value = normalizeUserTime(raw);
    if (value === null) {
      setMessage("יש להזין שעה בפורמט 24 שעות.");
      return;
    }

    const wpEnd = addMinutesToTime(value, 20);
    let nextExecution = setSandboxExecutionField(
      execution,
      currentBlock,
      "endBoilTime",
      value,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "wp.start",
      value,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "wp.end",
      wpEnd,
    );
    nextExecution = setSandboxExecutionField(
      nextExecution,
      currentBlock,
      "outToFermentor.start",
      wpEnd,
    );
    setExecution(nextExecution);
    await writeSheet("endBoilTime", [
      { range: stageCell(38, "E"), value },
      { range: stageCell(38, "F"), value: wpEnd },
      { range: stageCell(40, "E"), value: wpEnd },
    ]);
  }

  async function commitYeastPitch(raw: string) {
    const value = normalizeUserTime(raw);
    if (value === null) {
      setMessage("יש להזין שעה בפורמט 24 שעות.");
      return;
    }
    await commit("yeastPitchTime", value, [
      {
        range: `'גיליון1'!G${fermentationStartingRow(run.tankType)}`,
        value,
      },
    ]);
  }

  async function applyBoilRecommendation() {
    if (boilRecommendation === null) return;
    const value = String(Math.round(boilRecommendation));
    setBoilCalcOpen(false);
    setLocal("kettleVolume", value);
    await commitSugar("kettleVolume", value, 38, "C");
  }

  function isSheetBackedExecutionKey(key: string): boolean {
    return (
      key === "brewDate" ||
      key === "yeastPitchTime" ||
      key === "hltWaterAmount" ||
      key === "hltWaterTemp" ||
      key === "lauterWaterAmount" ||
      key === "lauterWaterTemp" ||
      key === "mashVolume" ||
      key === "mashPh" ||
      key === "mashAcid85" ||
      key === "boilAcid85" ||
      key === "outToBoilPh" ||
      key === "boilPh" ||
      key === "outToFermentorPh" ||
      key === "frPlato" ||
      key === "lrPlato" ||
      key === "kettlePlato" ||
      key === "kettleVolume" ||
      key === "endBoilPlato" ||
      key === "endBoilVolume" ||
      key === "fermentorSamplePlato" ||
      key === "cumulativeTankVolume" ||
      key === "endBoilTime" ||
      /^rinse[1-7]\.(time|amount|temp|kettle|grant)$/.test(key) ||
      /^hop[1-3]\.amountGrams$/.test(key) ||
      /^(mashIn|rest1|heat1|rest2|heat2|transferLt|restLt|circulation|outToBoil|endTransfer|boil|hop1|hop2|hop3|wp|outToFermentor)\.(start|end|temp|note)$/.test(
        key,
      )
    );
  }

  function syncFieldLabel(key: string): string {
    const labels: Record<string, string> = {
      brewDate: "תאריך בישול",
      hltWaterAmount: "כמות HLT",
      hltWaterTemp: "טמפ׳ HLT",
      lauterWaterAmount: "מי מאש",
      lauterWaterTemp: "טמפ׳ מי מאש",
      mashVolume: "נפח מאש",
      mashPh: "pH מאש",
      mashAcid85: "חומצה במאש",
      outToBoilPh: "pH בהוצאה לבישול",
      boilPh: "pH תחילת רתיחה",
      boilAcid85: "חומצה ברתיחה",
      kettlePlato: "Plato בסיר",
      kettleVolume: "נפח בסיר",
      endBoilPlato: "Plato סוף רתיחה",
      endBoilVolume: "נפח סוף רתיחה",
      fermentorSamplePlato: "Plato תחילת תסיסה",
      cumulativeTankVolume: "נפח תחילת תסיסה",
      outToFermentorPh: "pH בהוצאה לתסיסה",
      yeastPitchTime: "שעת הוספת שמרים",
      endBoilTime: "שעת סוף רתיחה",
    };
    if (labels[key]) return labels[key];

    const hopAmount = /^hop(\d+)\.amountGrams$/.exec(key);
    if (hopAmount) return `כמות כשות ${hopAmount[1]}`;

    const rinse = /^rinse(\d+)\.(.+)$/.exec(key);
    if (rinse) return `שטיפה ${rinse[1]} · ${rinse[2]}`;

    const stage = /^([^.]+)\.(start|end|temp|note)$/.exec(key);
    if (stage) {
      const def = TIMELINE_STAGES.find((item) => item.key === stage[1]);
      const suffix =
        stage[2] === "start"
          ? "התחלה"
          : stage[2] === "end"
            ? "סיום"
            : stage[2] === "temp"
              ? "טמפ׳"
              : "הערה";
      return `${def?.label || stage[1]} · ${suffix}`;
    }

    return key;
  }

  function syncComparable(value: unknown): string {
    const text = String(value ?? "").trim();
    if (!text) return "";

    const numeric = Number(text);
    if (Number.isFinite(numeric)) return String(numeric);

    if (text.includes(":") || text.includes(".")) {
      const time = normalizeUserTime(text);
      if (time !== null) return time;
    }

    return text.replace(/\s+/g, " ");
  }

  async function verifySheetSync() {
    if (!run.sheetId) return;

    setCheckingSync(true);
    setSyncError("");
    setMessage("");

    try {
      const mismatchDetails: SyncMismatch[] = [];

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

        const headerRow = blockHeaderRow(run.tankType, index);
        const dateRows = await readSandboxSheetRange(
          run.sheetId,
          `'גיליון1'!H${headerRow}:H${headerRow}`,
        );
        const brewDate = isoDateFromSheet(
          String(dateRows[0]?.[0] || ""),
        );
        if (brewDate) pulled.brewDate = brewDate;

        if (index === 1) {
          const fermentationRow = fermentationStartingRow(run.tankType);
          const yeastRows = await readSandboxSheetRange(
            run.sheetId,
            `'גיליון1'!G${fermentationRow}:G${fermentationRow}`,
          );
          const yeastTime = normalizedTime(
            String(yeastRows[0]?.[0] || ""),
          );
          if (yeastTime) pulled.yeastPitchTime = yeastTime;
        }

        const localFields =
          execution.blocks[String(index)]?.fields || {};
        const keys = new Set([
          ...Object.keys(localFields).filter(isSheetBackedExecutionKey),
          ...Object.keys(pulled).filter(isSheetBackedExecutionKey),
        ]);

        keys.forEach((key) => {
          const appValue = syncComparable(localFields[key]);
          const sheetValue = syncComparable(pulled[key]);
          if (appValue !== sheetValue) {
            mismatchDetails.push({
              blockIndex: index,
              key,
              label: syncFieldLabel(key),
              appValue: appValue || "—",
              sheetValue: sheetValue || "—",
            });
          }
        });
      }

      setSyncMismatchCount(mismatchDetails.length);
      setSyncMismatches(mismatchDetails);
      setLastVerifyAt(new Date());
      setMessage(
        mismatchDetails.length === 0
          ? "✓ בדיקת התאמה מלאה: הנתונים באפליקציה וב-Sheet תואמים."
          : `נמצאו ${mismatchDetails.length} פערים בין האפליקציה ל-Sheet — הפירוט מופיע מתחת.`,
      );
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "בדיקת ההתאמה מול ה-Sheet נכשלה.";
      setSyncError(detail);
      setMessage(detail);
    } finally {
      setCheckingSync(false);
    }
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

        const headerRow = blockHeaderRow(run.tankType, index);
        const dateRows = await readSandboxSheetRange(
          run.sheetId,
          `'גיליון1'!H${headerRow}:H${headerRow}`,
        );
        const brewDate = isoDateFromSheet(
          String(dateRows[0]?.[0] || ""),
        );
        if (brewDate) pulled.brewDate = brewDate;

        if (index === 1) {
          const fermentationRow = fermentationStartingRow(run.tankType);
          const yeastRows = await readSandboxSheetRange(
            run.sheetId,
            `'גיליון1'!G${fermentationRow}:G${fermentationRow}`,
          );
          const yeastTime = normalizedTime(
            String(yeastRows[0]?.[0] || ""),
          );
          if (yeastTime) pulled.yeastPitchTime = yeastTime;
        }

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
      setLastPullAt(new Date());
      setSyncMismatchCount(null);
      setSyncMismatches([]);
      setSyncError("");
      setMessage("✓ הנתונים נמשכו עכשיו מה-Sheet אל האפליקציה.");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "סנכרון הנתונים מה-Sheet נכשל.";
      setSyncError(detail);
      setMessage(detail);
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

  async function openAcidHistory(mode: "mash" | "boil") {
    setAcidHistoryMode(mode);
    setAcidHistoryLoading(true);
    setAcidHistoryError("");
    try {
      const rows = await loadMashAcidHistoryPreview(
        run.style,
        run.batchNumber,
      );
      setAcidHistory(rows);
    } catch (error) {
      setAcidHistoryError(
        error instanceof Error
          ? error.message
          : "טעינת היסטוריית החומצה נכשלה.",
      );
    } finally {
      setAcidHistoryLoading(false);
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

              <label className="brew-stage-start">
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
                <label className="brew-stage-end">
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
                <label className="brew-stage-temp">
                  טמפ׳
                  <input
                    type="number"
                    step="0.1"
                    value={
                      localValue(`${stage.key}.temp`) ||
                      (stage.key === "transferLt" ? "77.5" : "")
                    }
                    onFocus={(e) => e.currentTarget.select()}
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
                <label className="brew-stage-ph">
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
              <BeerLoader size="spinner" message="אפליקציה → Sheet…" />
            ) : pulling ? (
              <BeerLoader size="spinner" message="Sheet → אפליקציה…" />
            ) : (
              <div className="brew-sync-directions">
                <span>
                  אפליקציה → Sheet: {syncTimeLabel(lastPushAt)}
                </span>
                <span>
                  Sheet → אפליקציה: {syncTimeLabel(lastPullAt)}
                </span>
                <span
                  className={
                    syncMismatchCount === 0
                      ? "brew-sync-match"
                      : syncMismatchCount && syncMismatchCount > 0
                        ? "brew-sync-mismatch"
                        : ""
                  }
                >
                  התאמה מלאה:{" "}
                  {syncMismatchCount === null
                    ? "לא נבדקה"
                    : syncMismatchCount === 0
                      ? `✓ ${syncTimeLabel(lastVerifyAt)}`
                      : `⚠ ${syncMismatchCount} פערים`}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="brew-sync-actions">
          <button
            type="button"
            className="brew-button-secondary"
            disabled={
              checkingSync || pulling || !!syncing || !run.sheetId
            }
            onClick={() => void verifySheetSync()}
          >
            {checkingSync ? "בודק התאמה…" : "בדוק התאמה"}
          </button>
          <button
            type="button"
            className="brew-button-secondary brew-sync-now"
            disabled={pulling || !!syncing || !run.sheetId}
            onClick={() => void syncFromSheet()}
          >
            ↻ משוך מה-Sheet
          </button>
        </div>
      </div>

      {syncError && (
        <div className="brewing-message brewing-message-error">
          סנכרון ל-Sheet נכשל: {syncError}
        </div>
      )}
      {message && <div className="brewing-message">{message}</div>}

      {syncMismatches.length > 0 && (
        <details className="brew-sync-diff" open>
          <summary>
            פירוט {syncMismatches.length} הפערים
          </summary>
          <div className="brew-sync-diff-scroll">
            <table>
              <thead>
                <tr>
                  <th>בישול</th>
                  <th>שדה</th>
                  <th>באפליקציה</th>
                  <th>ב-Sheet</th>
                </tr>
              </thead>
              <tbody>
                {syncMismatches.map((item) => (
                  <tr key={`${item.blockIndex}-${item.key}`}>
                    <td>{(["A", "B", "C"] as const)[item.blockIndex - 1]}</td>
                    <td>{item.label}</td>
                    <td>{item.appValue}</td>
                    <td>{item.sheetValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="brew-sync-explainer">
        <span>
          ✓ / ⚠ ב-Stepper מציינים שלמות נתונים בלבד — לא מצב סנכרון.
        </span>
        <span>
          כתיבה: אפליקציה → Sheet אוטומטית. "בדוק התאמה" קורא בלי לשנות דבר; "משוך מה-Sheet" מעדכן את האפליקציה מהגיליון.
        </span>
      </div>

      <div className="brew-block-tabs">
        {Array.from({ length: totalBlocks }, (_, index) => index + 1).map(
          (index) => {
            const missing = blockMissingCount(index);
            const complete = missing === 0;
            return (
              <button
                type="button"
                key={index}
                className={[
                  currentBlock === index ? "active" : "",
                  complete ? "complete" : "warning",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={
                  complete
                    ? `בישול ${(["A", "B", "C"] as const)[index - 1]} הושלם`
                    : `חסרים ${missing} נתונים בבישול ${(["A", "B", "C"] as const)[index - 1]}`
                }
                onClick={() => void selectBlock(index)}
              >
                <span>בישול {(["A", "B", "C"] as const)[index - 1]}</span>
                <em>{complete ? "✓" : `⚠ ${missing}`}</em>
              </button>
            );
          },
        )}
      </div>

      <nav className="brew-step-progress" aria-label="שלבי טופס הבישול">
        {visibleSteps.map((step, index) => {
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
              <span className="brew-step-marker" aria-hidden="true">
                <b>{index + 1}</b>
                <em>{complete ? "✓" : "⚠"}</em>
              </span>
              <strong>{step.label}</strong>
            </button>
          );
        })}
      </nav>

      <section className="brew-step-panel">
        <div className="brew-step-panel-head">
          <div>
            <span>
              שלב {activeStep + 1} מתוך {visibleSteps.length}
            </span>
            <h3>{currentStep.label}</h3>
          </div>
        </div>

        {currentStep.id === "water" && (
          <div className="brew-prep-step">
            <article className="brew-prep-date-card">
              <div>
                <strong>תאריך בישול</strong>
                <small>
                  זה תאריך הבישול בפועל של בישול {["A", "B", "C"][currentBlock - 1]} — לא תאריך יצירת ה-Sheet.
                </small>
              </div>
              <label>
                תאריך
                <input
                  type="date"
                  value={localValue("brewDate")}
                  onChange={(e) => setLocal("brewDate", e.target.value)}
                  onBlur={(e) => void commitBrewDate(e.target.value)}
                />
              </label>
            </article>

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

            <article className="brew-material-confirmation">
              <div className="brew-section-title">
                <div>
                  <h4>חומרי גלם</h4>
                  <span>
                    ברירת המחדל היא האצווה שמסומנת כעת בשימוש בספרייה.
                  </span>
                </div>
                <small>
                  אפשר להחליף lot לפני האישור.
                </small>
              </div>

              <div className="brew-material-list">
                {brewMaterials.map((ingredient) => {
                  const selected = selectedMaterialLot(ingredient);
                  return (
                    <label
                      className="brew-material-row"
                      key={ingredient.id}
                    >
                      <span>
                        <strong>{ingredient.name}</strong>
                        <small>
                          {ingredient.category === "grain"
                            ? "לתת"
                            : ingredient.category === "hop"
                              ? "כשות"
                              : ingredient.category === "yeast"
                                ? "שמרים"
                                : "חומר גלם"}
                        </small>
                      </span>
                      <select
                        value={selected?.id || ""}
                        onChange={(e) =>
                          selectMaterialLot(
                            ingredient.id,
                            e.target.value,
                          )
                        }
                      >
                        {ingredient.lots.map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {[
                              lot.lotNumber || "ללא מספר lot",
                              lot.supplier || "",
                              lot.alpha !== undefined
                                ? "aa " + lot.alpha + "%"
                                : "",
                              lot.status === "current"
                                ? "בשימוש"
                                : lot.status === "next"
                                  ? "ממתין לשימוש"
                                  : lot.status === "ended"
                                    ? "נגמר"
                                    : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>

              <div className="brew-material-confirm-actions">
                <button
                  type="button"
                  className={
                    hasField("materialsConfirmed")
                      ? "brew-button-secondary"
                      : "btn-primary"
                  }
                  onClick={() => void confirmMaterials()}
                  disabled={!!syncing}
                >
                  {hasField("materialsConfirmed")
                    ? "✓ חומרי הגלם אושרו — אשר מחדש"
                    : "אשר אצוות חומרי גלם"}
                </button>
                <small>
                  האישור כותב את ה-lot / ספק / aa הרלוונטיים גם ל-Sheet.
                </small>
              </div>
            </article>
          </div>
        )}

        {currentStep.id === "mash" && (
          <>
            {currentBlock > 1 && (
              <div className="brew-step-context-bar">
                <span>
                  סיום הוצאה לתסיסה · בישול {["A", "B", "C"][currentBlock - 2]}
                </span>
                <strong>
                  {blockFields(currentBlock - 1)["outToFermentor.end"] || "—"}
                </strong>
                <small>תזכורת מהבישול הקודם לפני הכנסת לתת</small>
              </div>
            )}

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

              <div className="brew-acid-field">
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
                <button
                  type="button"
                  className="brew-button-secondary brew-acid-history-button"
                  onClick={() => void openAcidHistory("mash")}
                >
                  3 אצוות אחרונות
                </button>
              </div>
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

            <div className="brew-lauter-reading-row">
              <label>
                F.R.
                <input
                  type="number"
                  step="0.01"
                  value={localValue("frPlato")}
                  onChange={(e) => setLocal("frPlato", e.target.value)}
                  onBlur={(e) =>
                    void commitSugar("frPlato", e.target.value, 36, "B")
                  }
                />
              </label>
              <small>מדידת F.R. ליד ההוצאה לבישול</small>
            </div>

            <div className="brew-lauter-subsection">
              <div className="brew-section-title">
                <div>
                  <h4>שטיפות</h4>
                  <span>
                    {recipe.lautering.usesGrant
                      ? "נפח ב-Kettle + Grant"
                      : "נפח ב-Kettle"}
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
                      נפח ב-Kettle
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

            <div className="brew-lauter-end-transfer">
              {renderStageRows([END_TRANSFER_STAGE])}
              <div className="brew-lauter-reading-row">
                <label>
                  L.R.
                  <input
                    type="number"
                    step="0.01"
                    value={localValue("lrPlato")}
                    onChange={(e) => setLocal("lrPlato", e.target.value)}
                    onBlur={(e) =>
                      void commitSugar("lrPlato", e.target.value, 37, "B")
                    }
                  />
                </label>
                <small>מדידת L.R. ליד סוף ההעברה</small>
              </div>
            </div>
          </>
        )}

        {currentStep.id === "boil" && (
          <>
            <div className="brew-step-context-bar">
              <span>סוף העברה</span>
              <strong>{localValue("endTransfer.start") || "—"}</strong>
              <small>מוצג משלב הלאוטר · ללא עריכה כאן</small>
            </div>

            <div className="brew-boil-opening-grid">
              <label>
                Plato בסיר
                <input
                  type="number"
                  step="0.01"
                  value={localValue("kettlePlato")}
                  onChange={(e) => setLocal("kettlePlato", e.target.value)}
                  onBlur={(e) =>
                    void commitSugar("kettlePlato", e.target.value, 38, "B")
                  }
                />
              </label>

              <label>
                נפח בסיר
                <div className="brew-field-with-action">
                  <input
                    type="number"
                    value={localValue("kettleVolume")}
                    onChange={(e) => setLocal("kettleVolume", e.target.value)}
                    onBlur={(e) =>
                      void commitSugar("kettleVolume", e.target.value, 38, "C")
                    }
                  />
                  <button
                    type="button"
                    className="brew-button-secondary"
                    onClick={() => setBoilCalcOpen(true)}
                  >
                    מחשבון נפח רתיחה
                  </button>
                </div>
              </label>
            </div>

            <div className="brew-boil-start-row">
              <label>
                תחילת רתיחה
                <div className="brew-time-input">
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="HH:MM"
                    value={localValue("boil.start")}
                    onChange={(e) => setLocal("boil.start", e.target.value)}
                    onBlur={(e) => void commitBoilStart(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void commitBoilStart(hhmmNow())}
                  >
                    עכשיו
                  </button>
                </div>
              </label>

              <label>
                pH תחילת רתיחה
                <input
                  type="number"
                  step="0.01"
                  value={localValue("boilPh")}
                  onChange={(e) => setLocal("boilPh", e.target.value)}
                  onBlur={(e) =>
                    void commitPh("boilPh", e.target.value, stageCell(28, "F"))
                  }
                />
              </label>

              <label>
                תוספת H3PO4 85% (ML)
                <input
                  type="number"
                  step="0.1"
                  value={localValue("boilAcid85")}
                  onChange={(e) => setLocal("boilAcid85", e.target.value)}
                  onBlur={(e) => void commitBoilAcid(e.target.value)}
                />
              </label>

              <button
                type="button"
                className="brew-button-secondary brew-acid-history-button"
                onClick={() => void openAcidHistory("boil")}
              >
                השוואה לבישולים קודמים
              </button>
            </div>

            <div className="brew-boil-timeline">
              {boilHops.map((hop, index) => {
                const key = `hop${index + 1}.start`;
                const rowOffset = 30 + index * 2;
                const purpose =
                  hop.purpose === "bitterness"
                    ? "מרירות"
                    : hop.purpose === "aroma"
                      ? "ארומה"
                      : "ווירפול";
                return (
                  <div className="brew-boil-event-row" key={hop.id}>
                    <div>
                      <strong>כשות {index + 1} · {purpose}</strong>
                      <small>
                        {hop.boilMinutes ?? 0} דק׳ לסוף הרתיחה
                      </small>
                    </div>
                    <label>
                      שעה
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        placeholder="HH:MM"
                        value={localValue(key)}
                        onChange={(e) => setLocal(key, e.target.value)}
                        onBlur={(e) =>
                          void commitBoilEvent(key, rowOffset, e.target.value)
                        }
                      />
                    </label>
                    {(() => {
                      const dose = hopDose(hop);
                      const amountKey = `hop${index + 1}.amountGrams`;
                      const suggested =
                        dose.grams === null
                          ? ""
                          : String(Math.round(dose.grams));
                      return (
                        <>
                          <label>
                            כמות כשות (גרם)
                            <input
                              type="number"
                              step="1"
                              value={localValue(amountKey) || suggested}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) =>
                                setLocal(amountKey, e.target.value)
                              }
                              onBlur={(e) =>
                                void commitHopAmount(
                                  index,
                                  e.target.value || suggested,
                                )
                              }
                            />
                          </label>
                          <small className="brew-hop-dose-meta">
                            {dose.alpha === null
                              ? "aa —"
                              : `aa ${dose.alpha}%`}
                            {" · "}
                            {dose.gramsPerLiter === null
                              ? "—"
                              : `${dose.gramsPerLiter.toFixed(3)} ג׳/ל׳`}
                          </small>
                        </>
                      );
                    })()}
                  </div>
                );
              })}

              <div className="brew-boil-event-row brew-boil-end-row">
                <div>
                  <strong>סוף רתיחה</strong>
                  <small>{totalBoilMinutes} דק׳ מתחילת הרתיחה</small>
                </div>
                <label>
                  שעה
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="HH:MM"
                    value={localValue("endBoilTime")}
                    onChange={(e) => setLocal("endBoilTime", e.target.value)}
                    onBlur={(e) => void commitEndBoil(e.target.value)}
                  />
                </label>
              </div>
            </div>
          </>
        )}

        {currentStep.id === "transfer" && (
          <>
            <div className="brew-step-context-bar">
              <span>סוף רתיחה</span>
              <strong>
                {localValue("endBoilTime") || localValue("wp.start") || "—"}
              </strong>
              <small>תחילת WP שווה לזמן סוף הרתיחה</small>
            </div>

            <div className="brew-boil-opening-grid">
              <label>
                סוף רתיחה °P
                <input
                  type="number"
                  step="0.01"
                  value={localValue("endBoilPlato")}
                  onChange={(e) => setLocal("endBoilPlato", e.target.value)}
                  onBlur={(e) =>
                    void commitSugar("endBoilPlato", e.target.value, 39, "B")
                  }
                />
              </label>
              <label>
                נפח סוף רתיחה
                <input
                  type="number"
                  value={localValue("endBoilVolume")}
                  onChange={(e) => setLocal("endBoilVolume", e.target.value)}
                  onBlur={(e) =>
                    void commitSugar("endBoilVolume", e.target.value, 39, "C")
                  }
                />
              </label>
            </div>

            {renderStageRows([WP_STAGE, OUT_STAGE])}

            {currentBlock === 1 && (
              <div className="brew-yeast-pitch-row">
                <label>
                  שעת הוספת שמרים
                  <div className="brew-time-input">
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="HH:MM"
                      value={localValue("yeastPitchTime")}
                      onChange={(e) =>
                        setLocal("yeastPitchTime", e.target.value)
                      }
                      onBlur={(e) => void commitYeastPitch(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => void commitYeastPitch(hhmmNow())}
                    >
                      עכשיו
                    </button>
                  </div>
                </label>
                <small>נכתב גם בתחילת דף התסיסה</small>
              </div>
            )}

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
                תחילת תסיסה °P
                <input
                  type="number"
                  step="0.01"
                  value={localValue("fermentorSamplePlato")}
                  onChange={(e) =>
                    setLocal("fermentorSamplePlato", e.target.value)
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
                נפח תחילת תסיסה
                <div className="brew-volume-with-action">
                  <input
                    type="number"
                    value={localValue("cumulativeTankVolume")}
                    onChange={(e) =>
                      setLocal("cumulativeTankVolume", e.target.value)
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
                  <button
                    type="button"
                    className="brew-button-secondary"
                    onClick={() => {
                      setHeightCm("");
                      setHeightCalcOpen(true);
                    }}
                  >
                    מחשבון גובה
                  </button>
                </div>
              </label>

              <label>
                pH בהוצאה לתסיסה
                <input
                  type="number"
                  step="0.01"
                  value={localValue("outToFermentorPh")}
                  onChange={(e) =>
                    setLocal("outToFermentorPh", e.target.value)
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
                {stepMissingCount("summary") > 0
                  ? `חסרים ${stepMissingCount("summary")} נתונים`
                  : "כל נתוני הבישול הושלמו"}
              </h4>

              {missingItems.length > 0 && (
                <ul>
                  {missingItems.map((item) => (
                    <li key={item.label}>
                      {item.label} — חסרים {item.count}
                    </li>
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

      {acidHistoryMode && (
        <div
          className="brew-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAcidHistoryMode(null);
            }
          }}
        >
          <section
            className="brew-acid-history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="brew-acid-history-title"
          >
            <div className="brew-modal-header">
              <div>
                <h2 id="brew-acid-history-title">
                  {acidHistoryMode === "mash"
                    ? "השוואת חומצה במאש"
                    : "השוואת חומצה ברתיחה"}{" "}
                  · {run.style}
                </h2>
                <p>3 אצוות אחרונות · עד 9 בישולים · נשמר מקומית לטעינה חוזרת מהירה</p>
              </div>
              <button
                type="button"
                className="brew-modal-close brew-button-icon"
                onClick={() => setAcidHistoryMode(null)}
                aria-label="סגירה"
              >
                ×
              </button>
            </div>

            {acidHistoryMode === "boil" && (
              <div className="brew-acid-current-context">
                <div>
                  <span>pH מאש נוכחי</span>
                  <strong>{localValue("mashPh") || "—"}</strong>
                </div>
                <div>
                  <span>מ״ל חומצה במאש</span>
                  <strong>
                    {localValue("mashAcid85")
                      ? localValue("mashAcid85") + " ML"
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>pH הוצאה לבישול</span>
                  <strong>{localValue("outToBoilPh") || "—"}</strong>
                </div>
              </div>
            )}

            {acidHistoryLoading ? (
              <div className="brew-modal-loader">
                <BeerLoader size="small" message="טוען בישולים קודמים…" />
              </div>
            ) : acidHistoryError ? (
              <div className="brewing-message brewing-message-error">
                {acidHistoryError}
              </div>
            ) : acidHistory.length === 0 ? (
              <div className="brew-acid-history-empty">
                לא נמצאו נתונים קודמים לסגנון הזה.
              </div>
            ) : (
              <div className="brew-acid-history-scroll">
                <table className="brew-acid-history-table">
                  <thead>
                    <tr>
                      <th>אצווה / בישול</th>
                      <th>תאריך</th>
                      <th>pH מאש</th>
                      <th>נפח מאש</th>
                      <th>מ״ל חומצה במאש</th>
                      <th>pH הוצאה לבישול</th>
                      {acidHistoryMode === "boil" && (
                        <>
                          <th>pH תחילת רתיחה</th>
                          <th>מ״ל חומצה ברתיחה</th>
                          <th>pH בהוצאה לתסיסה</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {acidHistory.map((row) => (
                      <tr key={`${row.batchNumber}-${row.brewLetter}`}>
                        <td>
                          <a
                            href={row.sheetUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            #{row.batchNumber}{row.brewLetter}
                          </a>
                        </td>
                        <td>{row.brewDate || "—"}</td>
                        <td>{row.mashPh || "—"}</td>
                        <td>{row.mashVolume || "—"}</td>
                        <td>{row.acidMl || "—"}</td>
                        <td>{row.outToBoilPh || "—"}</td>
                        {acidHistoryMode === "boil" && (
                          <>
                            <td>{row.boilPh || "—"}</td>
                            <td>{row.boilAcidMl || "—"}</td>
                            <td>{row.outToFermentorPh || "—"}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {heightCalcOpen && (
        <div
          className="brew-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setHeightCalcOpen(false);
            }
          }}
        >
          <section
            className="brew-boil-calc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="brew-height-calc-title"
          >
            {(() => {
              const tankNumber = Number(run.tankNumber);
              const spec =
                tankNumber === 6
                  ? { base: 1300, cmPer100: 7.6, adjustment: 0, label: "מיכל 6" }
                  : run.tankType === "double"
                    ? { base: 1250, cmPer100: 9, adjustment: 0, label: "מיכל כפול" }
                    : run.tankType === "triple"
                      ? {
                          base: 2300,
                          cmPer100: 5,
                          adjustment: tankNumber === 11 ? -50 : 0,
                          label: tankNumber === 11 ? "מיכל משולש 11" : "מיכל משולש",
                        }
                      : null;
              const height = num(heightCm);
              const calculated =
                spec && height !== null
                  ? Math.round(
                      spec.base +
                        (100 * height) / spec.cmPer100 +
                        spec.adjustment,
                    )
                  : null;

              return (
                <>
                  <div className="brew-modal-header">
                    <div>
                      <h2 id="brew-height-calc-title">מחשבון גובה מיכל {run.tankNumber}</h2>
                      <p>
                        {spec
                          ? `${spec.label} · בסיס ${spec.base} ל׳ · כל ${spec.cmPer100} ס״מ = 100 ל׳${spec.adjustment ? " · תיקון -50 ל׳" : ""}`
                          : "אין במסמך הכיול נוסחת גובה למיכל בודד."}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="brew-modal-close brew-button-icon"
                      onClick={() => setHeightCalcOpen(false)}
                      aria-label="סגירה"
                    >
                      ×
                    </button>
                  </div>

                  {spec && (
                    <>
                      <div className="brew-boil-calc-fields">
                        <label>
                          גובה מדידה (ס״מ)
                          <input
                            type="number"
                            step="0.1"
                            autoFocus
                            value={heightCm}
                            onChange={(e) => setHeightCm(e.target.value)}
                          />
                        </label>
                      </div>

                      <div className="brew-calc-result">
                        <span>נפח מחושב</span>
                        <strong>
                          {calculated === null ? "—" : `${calculated} ל׳`}
                        </strong>
                      </div>
                    </>
                  )}

                  <div className="brew-modal-actions">
                    <button
                      type="button"
                      className="brew-button-secondary"
                      onClick={() => setHeightCalcOpen(false)}
                    >
                      סגור
                    </button>
                    {spec && (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={calculated === null}
                        onClick={() => {
                          if (calculated === null) return;
                          const value = String(calculated);
                          setHeightCalcOpen(false);
                          setHeightCm("");
                          setLocal("cumulativeTankVolume", value);
                          void commitSugar(
                            "cumulativeTankVolume",
                            value,
                            40,
                            "C",
                          );
                        }}
                      >
                        השתמש בנפח
                      </button>
                    )}
                  </div>
                </>
              );
            })()}
          </section>
        </div>
      )}

      {boilCalcOpen && (
        <div
          className="brew-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setBoilCalcOpen(false);
            }
          }}
        >
          <section
            className="brew-boil-calc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="brew-boil-calc-title"
          >
            <div className="brew-modal-header">
              <div>
                <h2 id="brew-boil-calc-title">מחשבון נפח רתיחה</h2>
                <p>
                  יעד סוף רתיחה: {recipe.targets.endBoilPlato}°P
                </p>
              </div>
              <button
                type="button"
                className="brew-modal-close brew-button-icon"
                onClick={() => setBoilCalcOpen(false)}
                aria-label="סגירה"
              >
                ×
              </button>
            </div>

            <div className="brew-boil-calc-fields">
              <label>
                נפח בזמן הדגימה
                <input
                  type="number"
                  value={localValue("boilSampleVolume") || "1200"}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) =>
                    setLocal("boilSampleVolume", e.target.value)
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
                    setLocal("boilSamplePlato", e.target.value)
                  }
                />
              </label>
              <label>
                פקטור אידוי (ל׳)
                <input
                  type="number"
                  value={localValue("boilEvaporationFactor") || "100"}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) =>
                    setLocal("boilEvaporationFactor", e.target.value)
                  }
                />
              </label>
            </div>

            <div className="brew-calc-result">
              <span>נפח יעד</span>
              <strong>
                {boilRecommendation === null
                  ? "—"
                  : Math.round(boilRecommendation) + " ל׳"}
              </strong>
            </div>

            <div className="brew-modal-actions">
              <button
                type="button"
                className="brew-button-secondary"
                onClick={() => setBoilCalcOpen(false)}
              >
                סגור
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={boilRecommendation === null}
                onClick={() => void applyBoilRecommendation()}
              >
                השתמש בנפח היעד
              </button>
            </div>
          </section>
        </div>
      )}

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
          onClick={() => {
            const isLastVisibleStep =
              activeStep >= visibleSteps.length - 1;

            if (!isLastVisibleStep) {
              setActiveStep((value) =>
                Math.min(visibleSteps.length - 1, value + 1),
              );
              return;
            }

            if (currentBlock < totalBlocks) {
              void selectBlock(currentBlock + 1);
              return;
            }

            if (currentStep.id === "summary") {
              onClose();
            }
          }}
        >
          {activeStep < visibleSteps.length - 1
            ? "הבא"
            : currentBlock < totalBlocks
              ? `מעבר לבישול ${(["A", "B", "C"] as const)[currentBlock]}`
              : currentStep.id === "summary"
                ? "סיום בישול"
                : "הבא"}
        </button>
      </div>
    </section>
  );
}
