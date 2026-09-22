import { useEffect, useMemo, useRef, useState } from "react";
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

type ValidationNotice = {
  kind: "warning" | "error";
  text: string;
  key?: string;
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

function shortIsraeliDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  return match ? `${match[3]}/${match[2]}/${match[1].slice(-2)}` : "";
}

function formatIsraeliDateTyping(value: string): string {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  if (digits.length < 2) return digits;
  if (digits.length === 2) return `${digits}/`;
  if (digits.length < 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  if (digits.length === 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/`;
  }

  const yearDigits =
    digits.length <= 6 ? digits.slice(4, 6) : digits.slice(4, 8);
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${yearDigits}`;
}

function isoDateFromUserInput(value: string): string | null {
  const text = String(value || "").trim();
  if (!text) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(text);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = match[3].length === 2 ? 2000 + rawYear : rawYear;
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function minutesFromMidnight(value: string): number | null {
  const normalized = normalizeUserTime(value);
  if (normalized === null || !normalized) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function forwardMinutes(from: string, to: string): number | null {
  const start = minutesFromMidnight(from);
  const end = minutesFromMidnight(to);
  if (start === null || end === null) return null;
  return (end - start + 24 * 60) % (24 * 60);
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

function roundToFive(value: number): number {
  return Math.round(value / 5) * 5;
}

function tankHeightCalibration(
  tankNumberValue: string,
  tankType: SandboxBrewRun["tankType"],
): { base: number; cmPer100: number; label: string; note?: string } | null {
  const tankNumber = Number(tankNumberValue);

  if (tankNumber === 6) {
    return { base: 1300, cmPer100: 7.6, label: "מיכל 6" };
  }

  if (tankType === "double") {
    return { base: 1250, cmPer100: 9, label: "מיכל כפול" };
  }

  if (tankType === "triple") {
    if (tankNumber === 11) {
      return {
        base: 2250,
        cmPer100: 5,
        label: "מיכל משולש 11",
        note: "ברירת המחדל כוללת את תיקון ה־50 ל׳ של מיכל 11",
      };
    }
    return { base: 2300, cmPer100: 5, label: "מיכל משולש" };
  }

  return null;
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

  for (let rowOffset = 42; rowOffset <= 45; rowOffset += 1) {
    const correction = sheetCell(rows, rowOffset, "E");
    if (!correction) continue;

    correction.split(/\r?\n/).forEach((line) => {
      const mashMatch = /^הערת מאש:\s*(.*)$/i.exec(line.trim());
      if (mashMatch) pulled["mashIn.note"] = mashMatch[1].trim();

      const generalMatch = /^הערה כללית:\s*(.*)$/i.exec(line.trim());
      if (generalMatch) pulled.generalNote = generalMatch[1].trim();
    });
  }

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
    const alpha = numericText(sheetCell(rows, 14 + index, "B"));
    if (amount) pulled[`hop${index}.amountGrams`] = amount;
    if (alpha) pulled[`hop${index}.alphaOverride`] = alpha;
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
  const [validationNotice, setValidationNotice] =
    useState<ValidationNotice | null>(null);
  const [validationConfirmText, setValidationConfirmText] = useState("");
  const validationConfirmResolver = useRef<((approved: boolean) => void) | null>(
    null,
  );
  const [reviewedSteps, setReviewedSteps] = useState<Record<string, boolean>>({});
  const [heightCalcOpen, setHeightCalcOpen] = useState(false);
  const [heightCm, setHeightCm] = useState("");
  const [heightBaseLiters, setHeightBaseLiters] = useState("");
  const initialProductionPullKey = useRef("");
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
  const isIpaStyle = String(run.style || "").toUpperCase().includes("IPA");

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
            endBoilVolumeLiters: num(
              blockFields.endBoilVolume || "",
            ),
          };
        }),
      ),
    [execution.blocks, totalBlocks],
  );

  const closestHistoryKey = useMemo(() => {
    if (!acidHistoryMode || acidHistory.length === 0) return "";

    const currentPh =
      acidHistoryMode === "mash"
        ? num(fields.mashPh || "")
        : num(fields.boilPh || "");
    if (currentPh === null) return "";

    const currentVolume =
      acidHistoryMode === "mash"
        ? num(fields.mashVolume || "")
        : num(fields.kettleVolume || "");

    const ranked = acidHistory
      .map((row) => {
        const rowPh =
          acidHistoryMode === "mash"
            ? num(row.mashPh || "")
            : num(row.boilPh || "");
        const rowVolume =
          acidHistoryMode === "mash"
            ? num(row.mashVolume || "")
            : num(row.kettleVolume || "");

        if (rowPh === null) return null;

        return {
          key: `${row.batchNumber}-${row.brewLetter}`,
          phDistance: Math.abs(rowPh - currentPh),
          volumeDistance:
            currentVolume !== null && rowVolume !== null
              ? Math.abs(rowVolume - currentVolume)
              : Number.POSITIVE_INFINITY,
        };
      })
      .filter(
        (
          row,
        ): row is {
          key: string;
          phDistance: number;
          volumeDistance: number;
        } => !!row,
      )
      .sort(
        (a, b) =>
          a.phDistance - b.phDistance ||
          a.volumeDistance - b.volumeDistance,
      );

    return ranked[0]?.key || "";
  }, [
    acidHistory,
    acidHistoryMode,
    fields.boilPh,
    fields.kettleVolume,
    fields.mashPh,
    fields.mashVolume,
  ]);

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
        "outToFermentorPh",
      ];
      if (
        blockIndex > 1 ||
        totalBlocks === 1 ||
        (blockIndex === 1 && !isIpaStyle)
      ) {
        required.push("cumulativeTankVolume");
      }
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

  function reviewedKey(blockIndex: number, stepId: StepId) {
    return `${blockIndex}:${stepId}`;
  }

  function isStepReviewedForBlock(blockIndex: number, stepId: StepId) {
    return reviewedSteps[reviewedKey(blockIndex, stepId)] === true;
  }

  function isCurrentStepReviewed() {
    return isStepReviewedForBlock(currentBlock, currentStep.id);
  }

  function markStepsReviewed(blockIndex: number, stepIds: StepId[]) {
    if (!stepIds.length) return;
    setReviewedSteps((previous) => {
      const next = { ...previous };
      stepIds.forEach((stepId) => {
        if (stepId !== "summary") {
          next[reviewedKey(blockIndex, stepId)] = true;
        }
      });
      return next;
    });
  }

  function blockHasReviewedMissing(blockIndex: number) {
    return (["water", "mash", "lautering", "boil", "transfer"] as StepId[]).some(
      (stepId) =>
        isStepReviewedForBlock(blockIndex, stepId) &&
        stepMissingCountForBlock(blockIndex, stepId) > 0,
    );
  }

  function markForwardNavigation(targetStepIndex: number) {
    if (targetStepIndex <= activeStep) return;
    markStepsReviewed(
      currentBlock,
      visibleSteps
        .slice(activeStep, targetStepIndex)
        .map((step) => step.id),
    );
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

  async function commitBrewDate(rawValue: string) {
    const value = isoDateFromUserInput(rawValue);
    if (value === null) {
      setValidationNotice({
        kind: "error",
        text: "תאריך הבישול חייב להיות בפורמט DD/MM/YY.",
      });
      return;
    }

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
            const grams = String(roundToFive(dose.grams));
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
    if (rejectTimelineTime(`${stage.key}.start`, value)) return;

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
      if (rejectTimelineTime(`${stage.key}.end`, value)) return;

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

    if (!(await approveNumericValue(`${stage.key}.temp`, value))) return;
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
    ]
      .filter(Boolean)
      .join("   ");
  }

  async function commitCorrectionNote(
    key: "mashIn.note" | "generalNote",
    prefix: "הערת מאש" | "הערה כללית",
    value: string,
  ) {
    const clean = value.trim();
    const correctionsLabelRow = baseRow + 41;
    const nextBoundaryRow =
      currentBlock < totalBlocks
        ? blockHeaderRow(run.tankType, currentBlock + 1)
        : fermentationStartingRow(run.tankType) - 2;
    const startRow = correctionsLabelRow + 1;
    const endRow = Math.max(startRow, nextBoundaryRow - 1);
    const rows = run.sheetId
      ? await readSandboxSheetRange(
          run.sheetId,
          `'גיליון1'!E${startRow}:E${endRow}`,
        )
      : [];

    const normalizedRows = Array.from({ length: endRow - startRow + 1 }, (_, index) =>
      String(rows[index]?.[0] || ""),
    );
    const prefixPattern = new RegExp(`^${prefix}:\\s*`, "i");
    const existingIndex = normalizedRows.findIndex((row) =>
      row.split(/\r?\n/).some((line) => prefixPattern.test(line.trim())),
    );

    let targetIndex = existingIndex;
    if (targetIndex < 0) {
      targetIndex = normalizedRows.findIndex((row) => !row.trim());
    }
    if (targetIndex < 0) {
      targetIndex = normalizedRows.length - 1;
    }

    const existing = normalizedRows[targetIndex];
    const lines = existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !prefixPattern.test(line));
    if (clean) lines.push(`${prefix}: ${clean}`);

    await commit(key, clean, [
      {
        range: `'גיליון1'!E${startRow + targetIndex}`,
        value: lines.join("\n"),
      },
    ]);
  }

  async function commitStageNote(stage: StageDef, value: string) {
    const key = `${stage.key}.note`;
    if (stage.key === "mashIn") {
      await commitCorrectionNote("mashIn.note", "הערת מאש", value);
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

  function immediateHardNumericError(key: string, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";

    const parsed = num(trimmed);
    if (parsed === null) return "";

    if (/Ph$/i.test(key) || key === "mashPh" || key === "boilPh") {
      if (parsed > 7) return `pH ${parsed} אינו ערך סביר לבישול (מקסימום 7).`;
      if (parsed < 0) return `pH ${parsed} אינו ערך סביר.`;
    }

    if (
      ["hltWaterAmount", "lauterWaterAmount"].includes(key) &&
      (parsed < 0 || parsed > 4000)
    ) {
      return `כמות מים ${parsed} ל׳ אינה סבירה (0–4000 ל׳).`;
    }

    if (/^hop\d+\.alphaOverride$/.test(key) && (parsed < 1 || parsed > 25)) {
      return `Alpha ${parsed}% אינו סביר לכשות (1–25%).`;
    }

    if (
      (key === "mashAcid85" || key === "boilAcid85") &&
      (parsed < 0 || parsed > 300)
    ) {
      return `כמות חומצה ${parsed} מ״ל אינה סבירה (0–300 מ״ל).`;
    }

    if (key === "lrPlato" && (parsed < 0 || parsed > 15)) {
      return `L.R. ${parsed}°P אינו סביר (טווח קשיח 0–15°P).`;
    }

    if (
      ["frPlato", "kettlePlato", "endBoilPlato", "fermentorSamplePlato"].includes(
        key,
      ) &&
      (parsed < 0 || parsed > 30)
    ) {
      return `Plato ${parsed} אינו סביר (מקסימום 30°P).`;
    }

    if (key === "mashVolume" && parsed > 2000) {
      return `נפח מאש ${parsed} ל׳ אינו סביר (מקסימום 2000 ל׳).`;
    }

    if (
      (key === "kettleVolume" || key === "endBoilVolume") &&
      parsed > 2500
    ) {
      return `נפח ${parsed} ל׳ אינו סביר (מקסימום 2500 ל׳).`;
    }

    if (/^rinse\d+\.amount$/.test(key) && (parsed < 0 || parsed > 500)) {
      return `כמות שטיפה ${parsed} ל׳ אינה סבירה (0–500 ל׳).`;
    }

    if (
      /^rinse\d+\.(kettle|grant)$/.test(key) &&
      (parsed < 0 || parsed > 2500)
    ) {
      return `נפח שטיפה ${parsed} ל׳ אינו סביר.`;
    }

    if (/^hop\d+\.amountGrams$/.test(key) && (parsed < 0 || parsed > 5000)) {
      return `כמות כשות ${parsed} גרם אינה סבירה.`;
    }

    if ((/Temp$/.test(key) || key.endsWith(".temp")) && (parsed < 0 || parsed > 100)) {
      return `טמפרטורה ${parsed}°C אינה סבירה.`;
    }

    if (key === "cumulativeTankVolume") {
      const absoluteMax =
        run.tankType === "single" ? 1700 : run.tankType === "double" ? 3100 : 4400;
      if (parsed > absoluteMax) {
        return `נפח מיכל ${parsed} ל׳ אינו סביר למיכל הזה.`;
      }

      const currentEndBoil = num(fields.endBoilVolume || "");
      const previous =
        currentBlock > 1
          ? num(blockFields(currentBlock - 1).cumulativeTankVolume || "")
          : 0;
      if (currentEndBoil !== null && previous !== null) {
        const added = parsed - previous;
        const minExpectedAdded = Math.max(0, currentEndBoil - 250);
        const maxExpectedAdded = currentEndBoil + 50;
        if (added > maxExpectedAdded) {
          return `נפח מצטבר ${parsed} ל׳ גבוה מדי ביחס לנפח סוף הרתיחה הנוכחי (${currentEndBoil} ל׳).`;
        }
      }
    }

    if (key === "endBoilVolume") {
      const dilution = dilutionValidation(parsed, undefined);
      if (dilution.hardError) return dilution.hardError;
    }

    return "";
  }

  async function askValidationConfirmation(text: string): Promise<boolean> {
    setValidationConfirmText(text);
    return new Promise<boolean>((resolve) => {
      validationConfirmResolver.current = resolve;
    });
  }

  function closeValidationConfirmation(approved: boolean) {
    const resolve = validationConfirmResolver.current;
    validationConfirmResolver.current = null;
    setValidationConfirmText("");
    resolve?.(approved);
  }

  function dilutionValidation(
    endVolumeOverride?: number | null,
    endPlatoOverride?: number | null,
  ): { hardError: string; warning: string } {
    const startVolume = num(fields.kettleVolume || "");
    const startPlato = num(fields.kettlePlato || "");
    const endVolume =
      endVolumeOverride === undefined
        ? num(fields.endBoilVolume || "")
        : endVolumeOverride;
    const endPlato =
      endPlatoOverride === undefined
        ? num(fields.endBoilPlato || "")
        : endPlatoOverride;

    if (
      startVolume === null ||
      endVolume === null ||
      endVolume <= startVolume
    ) {
      return { hardError: "", warning: "" };
    }

    if (startPlato === null || endPlato === null) {
      return {
        hardError: "",
        warning:
          `נפח סוף הרתיחה (${endVolume} ל׳) גבוה מנפח תחילת הרתיחה (${startVolume} ל׳). זה אפשרי בדילול; לאחר הזנת Plato סוף רתיחה תיבדק התאמת הדילול.`,
      };
    }

    if (endPlato >= startPlato) {
      return {
        hardError:
          `הנפח עלה מ-${startVolume} ל-${endVolume} ל׳ אבל ה-Plato לא ירד (${startPlato}→${endPlato}). הנתונים לא נראים כמו דילול.`,
        warning: "",
      };
    }

    const expected = (startPlato * startVolume) / endVolume;
    const delta = Math.abs(endPlato - expected);

    if (delta > 0.8) {
      return {
        hardError:
          `הנפח גדל ונראה שהיה דילול, אבל לפי ${startVolume} ל׳ ב-${startPlato}°P ה-Plato הצפוי אחרי ${endVolume} ל׳ הוא בערך ${expected.toFixed(2)}°P. הוזן ${endPlato}°P.`,
        warning: "",
      };
    }

    if (delta > 0.35) {
      return {
        hardError: "",
        warning:
          `הדילול אפשרי, אבל ה-Plato הצפוי לפי מאזן הסוכר הוא כ-${expected.toFixed(2)}°P והוזן ${endPlato}°P.`,
      };
    }

    return { hardError: "", warning: "" };
  }

  async function approveNumericValue(
    key: string,
    value: string,
  ): Promise<boolean> {
    const trimmed = value.trim();
    if (!trimmed) return true;

    const parsed = num(trimmed);
    if (parsed === null) {
      restoreCommittedField(key);
      setValidationNotice({
        kind: "error",
        text: "הערך חייב להיות מספר. הנתון לא נשמר.",
      });
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
      const minPlato = key === "lrPlato" ? 0 : 3;
      const maxPlato = key === "lrPlato" ? 15 : 30;
      if (parsed < minPlato || parsed > maxPlato) {
        hardError =
          key === "lrPlato"
            ? `L.R. ${parsed}°P אינו סביר (טווח קשיח 0–15°P).`
            : `Plato ${parsed} אינו סביר (טווח קשיח 3–30°P).`;
      } else if (key === "frPlato" && (parsed < 8 || parsed > 25)) {
        warning = `F.R. ${parsed}°P חריג ביחס לבישולים האחרונים.`;
      } else if (key === "lrPlato" && parsed > 8) {
        warning = `L.R. ${parsed}°P גבוה ביחס לבישולים הרגילים.`;
      } else if (
        ["kettlePlato", "endBoilPlato", "fermentorSamplePlato"].includes(key) &&
        recipe.targets.endBoilPlato > 0 &&
        Math.abs(parsed - recipe.targets.endBoilPlato) > 3
      ) {
        warning = `הערך ${parsed}°P רחוק ביותר מ-3°P מיעד סוף הרתיחה ${recipe.targets.endBoilPlato}°P.`;
      }

      if (key === "endBoilPlato") {
        const dilution = dilutionValidation(undefined, parsed);
        if (dilution.hardError) hardError = dilution.hardError;
        else if (dilution.warning) warning = dilution.warning;
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
          if (parsed > startVolume) {
            const dilution = dilutionValidation(parsed, undefined);
            if (dilution.hardError) hardError = dilution.hardError;
            else if (dilution.warning) warning = dilution.warning;
          } else if (loss > 300 || loss / startVolume > 0.2) {
            warning = `אובדן של ${Math.round(loss)} ל׳ ברתיחה חריג מאוד.`;
          }
        }
      }
    } else if (key === "cumulativeTankVolume") {
      const absoluteMax =
        run.tankType === "single" ? 1700 : run.tankType === "double" ? 3100 : 4400;
      if (parsed < 400 || parsed > absoluteMax) {
        hardError = `נפח מיכל ${parsed} ל׳ אינו סביר למיכל הזה.`;
      }

      const currentEndBoil = num(fields.endBoilVolume || "");
      const previous =
        currentBlock > 1
          ? num(blockFields(currentBlock - 1).cumulativeTankVolume || "")
          : 0;

      if (!hardError && currentEndBoil !== null && previous !== null) {
        const added = parsed - previous;
        const minExpectedAdded = Math.max(0, currentEndBoil - 250);
        const maxExpectedAdded = currentEndBoil + 50;

        if (added < minExpectedAdded || added > maxExpectedAdded) {
          hardError =
            currentBlock > 1
              ? `נפח מצטבר ${parsed} ל׳ לא מתאים לבישול הנוכחי: מהבישול הקודם היו ${previous} ל׳ וסוף הרתיחה הנוכחי הוא ${currentEndBoil} ל׳. תוספת סבירה היא בערך ${minExpectedAdded}–${maxExpectedAdded} ל׳.`
              : `נפח תחילת תסיסה ${parsed} ל׳ לא מתאים לנפח סוף הרתיחה ${currentEndBoil} ל׳.`;
        }
      } else if (!hardError && currentBlock > 1 && previous === null) {
        const endBoilVolumes = Array.from(
          { length: currentBlock },
          (_, index) =>
            num(
              execution.blocks[String(index + 1)]?.fields?.endBoilVolume || "",
            ),
        );

        if (endBoilVolumes.every((volume) => volume !== null)) {
          const totalEndBoil = endBoilVolumes.reduce(
            (sum, volume) => sum + Number(volume),
            0,
          );
          const minExpected = Math.max(
            0,
            totalEndBoil - 180 * currentBlock,
          );
          const maxExpected = totalEndBoil + 20;

          if (parsed < minExpected || parsed > maxExpected) {
            hardError = `נפח מצטבר ${parsed} ל׳ לא מתאים לנפחי סוף הרתיחה של האצווה (סה״כ ${Math.round(totalEndBoil)} ל׳). טווח סביר בשלב הזה הוא בערך ${Math.round(minExpected)}–${Math.round(maxExpected)} ל׳.`;
          }
        }
      }
    } else if (/^rinse\d+\.amount$/.test(key)) {
      if (parsed < 0 || parsed > 500) {
        hardError = `כמות שטיפה ${parsed} ל׳ אינה סבירה (0–500 ל׳).`;
      } else if (parsed > 300) {
        warning = `כמות שטיפה ${parsed} ל׳ חריגה ביחס לשטיפות הרגילות.`;
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
      restoreCommittedField(key);
      setValidationNotice({
        kind: "error",
        text: `${hardError} הנתון לא נשמר — בדוק שאין TYPO.`,
      });
      return false;
    }

    if (warning) {
      const approved = await askValidationConfirmation(warning);
      if (!approved) {
        restoreCommittedField(key);
        setValidationNotice({
          kind: "warning",
          text: `${warning} השמירה בוטלה כדי לאפשר תיקון.`,
        });
        return false;
      }
      setValidationNotice({
        kind: "warning",
        text: `${warning} הנתון נשמר לאחר אישור.`,
      });
      return true;
    }

    setValidationNotice(null);
    return true;
  }

  async function commitMashMeta(
    field: "mashVolume" | "mashPh",
    value: string,
  ) {
    if (!(await approveNumericValue(field, value))) return;
    const nextFields = { ...fields, [field]: value };
    await commit(field, value, [
      {
        range: stageCell(0, "H"),
        value: mashMetaText(nextFields),
      },
    ]);

    if (String(nextFields["mashIn.note"] || "").trim()) {
      await commitCorrectionNote(
        "mashIn.note",
        "הערת מאש",
        nextFields["mashIn.note"],
      );
    }
  }

  async function commitMashAcid(value: string) {
    if (!(await approveNumericValue("mashAcid85", value))) return;
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

    if (field.endsWith("Temp")) {
      if (!(await approveNumericValue(field, value))) return;
    } else if (value.trim()) {
      const parsedAmount = num(value);
      if (parsedAmount === null || parsedAmount < 0 || parsedAmount > 4000) {
        restoreCommittedField(field);
        setValidationNotice({
          kind: "error",
          text: `כמות מים "${value}" אינה סבירה (0–4000 ל׳). הנתון לא נשמר.`,
        });
        return;
      }
    }

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
    if (!(await approveNumericValue(key, value))) return;
    await commit(key, value, [
      { range, value: value ? `pH ${value}` : "" },
    ]);
  }

  function timelineOrder(): Array<{ key: string; label: string }> {
    const result: Array<{ key: string; label: string }> = [];

    [...MASH_STAGES, ...LAUTER_STAGES].forEach((stage) => {
      result.push({ key: `${stage.key}.start`, label: `${stage.label} – התחלה` });
      if (stage.showEnd !== false) {
        result.push({ key: `${stage.key}.end`, label: `${stage.label} – סיום` });
      }
    });

    for (let index = 1; index <= 7; index += 1) {
      result.push({ key: `rinse${index}.time`, label: `שטיפה ${index}` });
    }

    result.push({ key: "endTransfer.start", label: "סוף העברה" });
    result.push({ key: "boil.start", label: "תחילת רתיחה" });

    boilHops.forEach((_, index) => {
      result.push({
        key: `hop${index + 1}.start`,
        label: `כשות ${index + 1}`,
      });
    });

    result.push({ key: "endBoilTime", label: "סוף רתיחה" });
    result.push({ key: "wp.start", label: "תחילת WP" });
    result.push({ key: "wp.end", label: "סוף WP" });
    result.push({ key: "outToFermentor.start", label: "תחילת הוצאה לתסיסה" });
    if (currentBlock === 1) {
      result.push({ key: "yeastPitchTime", label: "הוספת שמרים" });
    }
    result.push({ key: "outToFermentor.end", label: "סיום הוצאה לתסיסה" });

    return result;
  }

  function validateTimelineTime(key: string, value: string): string {
    if (!value) return "";
    const order = timelineOrder();
    const currentIndex = order.findIndex((item) => item.key === key);
    if (currentIndex < 0) return "";

    let previous: { key: string; label: string; value: string } | null = null;
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const candidate = String(fields[order[index].key] || "").trim();
      if (candidate) {
        previous = { ...order[index], value: candidate };
        break;
      }
    }

    let next: { key: string; label: string; value: string } | null = null;
    for (let index = currentIndex + 1; index < order.length; index += 1) {
      const candidate = String(fields[order[index].key] || "").trim();
      if (candidate) {
        next = { ...order[index], value: candidate };
        break;
      }
    }

    const maxForwardMinutes = 20 * 60;

    if (previous) {
      const delta = forwardMinutes(previous.value, value);
      if (delta !== null && delta > maxForwardMinutes) {
        return `${order[currentIndex].label} (${value}) מוקדם מ-${previous.label} (${previous.value}).`;
      }
    }

    if (next) {
      const delta = forwardMinutes(value, next.value);
      if (delta !== null && delta > maxForwardMinutes) {
        return `${order[currentIndex].label} (${value}) מאוחר מ-${next.label} (${next.value}).`;
      }
    }

    return "";
  }

  function rejectTimelineTime(key: string, value: string): boolean {
    const error = validateTimelineTime(key, value);
    if (!error) return false;

    restoreCommittedField(key);
    setValidationNotice({
      kind: "error",
      key,
      text: `${error} הנתון לא נשמר.`,
    });
    return true;
  }

  async function commitRinse(
    index: number,
    field: string,
    value: string,
  ) {
    const rowOffset = 18 + (index - 1);
    const key = `rinse${index}.${field}`;

    if (field === "time") {
      if (rejectTimelineTime(key, value)) return;

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
      if (!(await approveNumericValue(key, value))) return;
      return commit(key, value, [
        { range: stageCell(rowOffset, "F"), value: num(value) ?? value },
      ]);
    }
    if (field === "temp") {
      if (!(await approveNumericValue(key, value))) return;
      return commit(key, value, [
        {
          range: stageCell(rowOffset, "G"),
          value: value ? `${value}°C` : "",
        },
      ]);
    }

    if (!(await approveNumericValue(key, value))) return;
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
    if (!(await approveNumericValue(key, value))) return;
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

        const grams = String(roundToFive(dose.grams));
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
    if (!(await approveNumericValue("boilAcid85", value))) return;
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
      restoreCommittedField("boil.start");
      setValidationNotice({
        kind: "error",
        text: "יש להזין שעה בפורמט 24 שעות, למשל 10:35.",
      });
      return;
    }

    if (rejectTimelineTime("boil.start", value)) return;

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
      restoreCommittedField(key);
      setValidationNotice({
        kind: "error",
        text: "יש להזין שעה בפורמט 24 שעות.",
      });
      return;
    }
    if (rejectTimelineTime(key, value)) return;

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
    const hopIndex = boilHops.findIndex((item) => item.id === hop.id);
    const alphaOverride =
      hopIndex >= 0
        ? num(fields[`hop${hopIndex + 1}.alphaOverride`] || "")
        : null;
    const alpha =
      alphaOverride !== null
        ? alphaOverride
        : lot?.alpha !== undefined && Number.isFinite(Number(lot.alpha))
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
    if (!(await approveNumericValue(key, value))) return;

    const parsed = num(value);
    const rounded =
      parsed === null ? "" : String(roundToFive(parsed));

    await commit(key, rounded, [
      {
        range: `'גיליון1'!A${baseRow + 15 + index}`,
        value: rounded === "" ? "" : Number(rounded),
      },
    ]);
  }

  async function commitHopAlpha(index: number, value: string) {
    const key = `hop${index + 1}.alphaOverride`;
    const parsed = num(value);

    if (value.trim() && (parsed === null || parsed < 1 || parsed > 25)) {
      restoreCommittedField(key);
      setValidationNotice({
        kind: "error",
        text: `Alpha ${value}% אינו סביר לכשות (1–25%). הנתון לא נשמר.`,
      });
      return;
    }

    let nextExecution = setSandboxExecutionField(
      execution,
      currentBlock,
      key,
      value,
    );
    const writes: Array<{
      range: string;
      value: string | number | boolean | null;
    }> = [
      {
        range: `'גיליון1'!B${baseRow + 15 + index}`,
        value: parsed ?? "",
      },
    ];

    const hop = boilHops[index];
    const kettleVolume = num(fields.kettleVolume || "");
    if (
      hop?.purpose === "bitterness" &&
      parsed !== null &&
      parsed > 0 &&
      kettleVolume !== null &&
      Number.isFinite(Number(hop.aa)) &&
      Number(hop.aa) > 0
    ) {
      const gramsPerLiter =
        (Number(hop.gramsPerLiter || 0) * Number(hop.aa)) / parsed;
      const grams = roundToFive(gramsPerLiter * kettleVolume);
      const amountKey = `hop${index + 1}.amountGrams`;

      nextExecution = setSandboxExecutionField(
        nextExecution,
        currentBlock,
        amountKey,
        String(grams),
      );
      writes.push({
        range: `'גיליון1'!A${baseRow + 15 + index}`,
        value: grams,
      });
    }

    setExecution(nextExecution);
    await writeSheet(key, writes);
  }

  async function commitEndBoil(raw: string) {
    const value = normalizeUserTime(raw);
    if (value === null) {
      restoreCommittedField("endBoilTime");
      setValidationNotice({
        kind: "error",
        text: "יש להזין שעה בפורמט 24 שעות.",
      });
      return;
    }

    if (rejectTimelineTime("endBoilTime", value)) return;

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
      restoreCommittedField("yeastPitchTime");
      setValidationNotice({
        kind: "error",
        text: "יש להזין שעה בפורמט 24 שעות.",
      });
      return;
    }
    if (rejectTimelineTime("yeastPitchTime", value)) return;

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
      key === "generalNote" ||
      /^rinse[1-7]\.(time|amount|temp|kettle|grant)$/.test(key) ||
      /^hop[1-3]\.(amountGrams|alphaOverride)$/.test(key) ||
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
      generalNote: "הערה כללית / תיקונים",
    };
    if (labels[key]) return labels[key];

    const hopAmount = /^hop(\d+)\.amountGrams$/.exec(key);
    if (hopAmount) return `כמות כשות ${hopAmount[1]}`;

    const hopAlpha = /^hop(\d+)\.alphaOverride$/.exec(key);
    if (hopAlpha) return `Alpha כשות ${hopAlpha[1]}`;

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

  function isStandbyRinseDifference(
    key: string,
    localFields: Record<string, string>,
    sheetFields: Record<string, string>,
  ): boolean {
    const match = /^rinse(\d+)\.amount$/.exec(key);
    if (!match) return false;

    const index = match[1];
    const evidenceKeys = [
      `rinse${index}.time`,
      `rinse${index}.temp`,
      `rinse${index}.kettle`,
      `rinse${index}.grant`,
    ];
    const hasRealRinse = evidenceKeys.some(
      (evidenceKey) =>
        String(localFields[evidenceKey] || "").trim() !== "" ||
        String(sheetFields[evidenceKey] || "").trim() !== "",
    );
    if (hasRealRinse) return false;

    const localAmount = String(localFields[key] || "").trim();
    const sheetAmount = String(sheetFields[key] || "").trim();

    return (
      (localAmount === "150" && sheetAmount === "") ||
      (sheetAmount === "150" && localAmount === "")
    );
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
          `'גיליון1'!A${row}:H${row + 45}`,
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
          if (isStandbyRinseDifference(key, localFields, pulled)) {
            return;
          }

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
          `'גיליון1'!A${row}:H${row + 45}`,
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

  useEffect(() => {
    if (
      run.source !== "production" ||
      !run.sheetId ||
      initialProductionPullKey.current === run.batchNumber
    ) {
      return;
    }

    initialProductionPullKey.current = run.batchNumber;
    void syncFromSheet();
    // Intentionally pull once when a real batch is opened for editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.batchNumber, run.sheetId, run.source]);

  async function selectBlock(index: number) {
    setExecution(setSandboxExecutionActiveBlock(execution, index));
    setActiveStep(0);
    setMessage("");
  }

  function setLocal(key: string, value: string) {
    const hardError = immediateHardNumericError(key, value);
    if (hardError) {
      setValidationNotice({
        kind: "error",
        key,
        text: `${hardError} הנתון לא יישמר.`,
      });
    } else {
      setValidationNotice((previous) =>
        previous?.kind === "error" && previous.key === key
          ? null
          : previous,
      );
    }

    const blockKey = String(currentBlock);
    setExecution((previous) => ({
      ...previous,
      blocks: {
        ...previous.blocks,
        [blockKey]: {
          fields: {
            ...(previous.blocks[blockKey]?.fields || {}),
            [key]: value,
          },
        },
      },
    }));
  }

  function restoreCommittedField(key: string) {
    const committed = loadSandboxExecution(run.batchNumber);
    const value =
      committed.blocks[String(currentBlock)]?.fields?.[key] || "";
    const blockKey = String(currentBlock);

    setExecution((previous) => ({
      ...previous,
      blocks: {
        ...previous.blocks,
        [blockKey]: {
          fields: {
            ...(previous.blocks[blockKey]?.fields || {}),
            [key]: value,
          },
        },
      },
    }));
  }

  async function commitTypedStageTime(
    stage: StageDef,
    field: "start" | "end",
    raw: string,
  ) {
    const normalized = normalizeUserTime(raw);
    if (normalized === null) {
      restoreCommittedField(`${stage.key}.${field}`);
      setValidationNotice({
        kind: "error",
        text: "יש להזין שעה בפורמט 24 שעות, למשל 08:22 או 1845.",
      });
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

  function transferDurationText(): string {
    const start = localValue("outToBoil.start");
    const end = localValue("endTransfer.start");
    if (!start || !end) return "";

    const minutes = forwardMinutes(start, end);
    if (minutes === null || minutes > 8 * 60) return "";
    return `מהוצאה לבישול עד סוף העברה: ${minutes} דק׳`;
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
                {stage.key === "endTransfer" && transferDurationText() && (
                  <small className="brew-stage-duration">
                    {transferDurationText()}
                  </small>
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
                    required
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
                      required
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
                    required
                    className={
                      hasField(`${stage.key}.temp`) ? "" : "brew-input-missing"
                    }
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
                    required
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

      {run.source === "production" && (
        <div className="brew-real-data-banner" role="status">
          <strong>נתוני אמת</strong>
          <span>
            עריכה כאן כותבת ישירות ל-Sheet המקורי של אצווה {run.batchNumber}.
            ACTION / Stage של המיכל אינם משתנים מהמסך הזה.
          </span>
        </div>
      )}

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

        {validationNotice && (
          <div
            className={`brew-validation-notice ${validationNotice.kind}`}
            role="alert"
          >
            <span>{validationNotice.kind === "error" ? "⛔" : "⚠️"}</span>
            <strong>{validationNotice.text}</strong>
            <button
              type="button"
              aria-label="סגור הודעת ולידציה"
              onClick={() => setValidationNotice(null)}
            >
              ×
            </button>
          </div>
        )}

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
                  key={`${currentBlock}-${localValue("brewDate")}`}
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  placeholder="DD/MM/YY"
                  required
                  defaultValue={shortIsraeliDate(localValue("brewDate"))}
                  onInput={(e) => {
                    e.currentTarget.value = formatIsraeliDateTyping(
                      e.currentTarget.value,
                    );
                  }}
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
                    required
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
                    required
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
                    required
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
                    required
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

            <article
              className={[
                "brew-material-confirmation",
                !hasField("materialsConfirmed") ? "brew-required-missing" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
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
                  required
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
                  required
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
                    required
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
              <button
                type="button"
                className="brew-button-secondary"
                onClick={() => setBoilCalcOpen(true)}
              >
                מחשבון נפח רתיחה
              </button>
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
                          required={index === 1}
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
                              restoreCommittedField(`rinse${index}.time`);
                              setValidationNotice({
                                kind: "error",
                                text: "יש להזין שעה בפורמט 24 שעות, למשל 08:22 או 1845.",
                              });
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
                        required={index === 1}
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
                        required={index === 1}
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
                          required={index === 1}
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
                  required
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
                    required
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
                    required
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
                  required
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
                  required
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
                        required
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
                          : String(roundToFive(dose.grams));
                      return (
                        <>
                          <label>
                            כמות כשות (גרם)
                            <input
                              type="number"
                              step="1"
                              required
                              className={
                                hasField(amountKey) ? "" : "brew-input-missing"
                              }
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
                          {hop.purpose === "bitterness" && (
                            <label className="brew-hop-alpha-field">
                              Alpha %
                              <input
                                type="number"
                                step="0.1"
                                min="1"
                                max="25"
                                value={
                                  localValue(`hop${index + 1}.alphaOverride`) ||
                                  (dose.alpha === null ? "" : String(dose.alpha))
                                }
                                onChange={(e) =>
                                  setLocal(
                                    `hop${index + 1}.alphaOverride`,
                                    e.target.value,
                                  )
                                }
                                onBlur={(e) =>
                                  void commitHopAlpha(index, e.target.value)
                                }
                              />
                            </label>
                          )}
                          <small className="brew-hop-dose-meta">
                            {dose.gramsPerLiter === null
                              ? "—"
                              : `${dose.gramsPerLiter.toFixed(3)} ג׳/ל׳`}
                            {hop.purpose !== "bitterness" && (
                              <>
                                {" · "}
                                {dose.alpha === null
                                  ? "aa —"
                                  : `aa ${dose.alpha}%`}
                              </>
                            )}
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
                    required
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
                  required
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
                  required
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
                      required
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
                    ? `זמני · ${startingPlato.completedBlocks}/${totalBlocks} בישולים · לפי °P סוף רתיחה + 0.05`
                    : "סופי · ממוצע משוקלל לפי °P סוף רתיחה + 0.05 ונפחים מצטברים"}
              </small>
            </div>

            <div className="brew-sugar-grid">
              <label>
                תחילת תסיסה °P
                <input
                  type="number"
                  step="0.01"
                  required
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
                    required={
                      currentBlock > 1 ||
                      totalBlocks === 1 ||
                      (currentBlock === 1 && !isIpaStyle)
                    }
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
                      const calibration = tankHeightCalibration(
                        String(run.tankNumber),
                        run.tankType,
                      );
                      setHeightCm("");
                      setHeightBaseLiters(
                        calibration ? String(calibration.base) : "",
                      );
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
                  required
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

            <label className="brew-general-note">
              הערה כללית / תיקונים
              <textarea
                rows={3}
                value={localValue("generalNote")}
                placeholder="הערה שתישמר באזור תיקונים ב-Sheet"
                onChange={(e) => setLocal("generalNote", e.target.value)}
                onBlur={(e) =>
                  void commitCorrectionNote(
                    "generalNote",
                    "הערה כללית",
                    e.target.value,
                  )
                }
              />
            </label>
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

      {validationConfirmText && (
        <div className="brew-modal-backdrop" role="presentation">
          <section
            className="brew-validation-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="brew-validation-confirm-title"
          >
            <div className="brew-modal-header">
              <div>
                <h2 id="brew-validation-confirm-title">בדיקת נתון</h2>
                <p>הנתון חריג, אבל ייתכן שהוא נכון.</p>
              </div>
              <button
                type="button"
                className="brew-modal-close brew-button-icon"
                onClick={() => closeValidationConfirmation(false)}
                aria-label="סגירה"
              >
                ×
              </button>
            </div>

            <p className="brew-validation-confirm-text">
              {validationConfirmText}
            </p>

            <div className="brew-modal-actions">
              <button
                type="button"
                className="brew-button-secondary"
                onClick={() => closeValidationConfirmation(false)}
              >
                חזור לתיקון
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => closeValidationConfirmation(true)}
              >
                שמור בכל זאת
              </button>
            </div>
          </section>
        </div>
      )}

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
                <p>3 אצוות אחרונות · עד 9 בישולים</p>
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
                <div>
                  <span>נפח רתיחה</span>
                  <strong>
                    {localValue("kettleVolume")
                      ? localValue("kettleVolume") + " ל׳"
                      : "—"}
                  </strong>
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
                      <th>אצווה</th>
                      <th>תאריך</th>
                      <th>pH מאש</th>
                      <th>נפח מאש</th>
                      <th>מ״ל חומצה במאש</th>
                      <th>pH הוצאה לבישול</th>
                      {acidHistoryMode === "boil" && (
                        <>
                          <th>נפח רתיחה</th>
                          <th>pH תחילת רתיחה</th>
                          <th>מ״ל חומצה ברתיחה</th>
                          <th>pH בהוצאה לתסיסה</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {acidHistory.map((row) => (
                      <tr
                        key={`${row.batchNumber}-${row.brewLetter}`}
                        className={
                          closestHistoryKey ===
                          `${row.batchNumber}-${row.brewLetter}`
                            ? "brew-history-closest"
                            : ""
                        }
                      >
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
                            <td>{row.kettleVolume ? row.kettleVolume + " ל׳" : "—"}</td>
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
              const spec = tankHeightCalibration(
                String(run.tankNumber),
                run.tankType,
              );
              const height = num(heightCm);
              const base = num(heightBaseLiters);
              const calculated =
                spec && height !== null && base !== null
                  ? Math.round(base + (100 * height) / spec.cmPer100)
                  : null;

              return (
                <>
                  <div className="brew-modal-header">
                    <div>
                      <h2 id="brew-height-calc-title">מחשבון גובה מיכל {run.tankNumber}</h2>
                      <p>
                        {spec
                          ? `${spec.label} · כל ${spec.cmPer100} ס״מ = 100 ל׳${spec.note ? ` · ${spec.note}` : ""}`
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
                          בסיס נפח (ל׳)
                          <input
                            type="number"
                            step="1"
                            value={heightBaseLiters}
                            onChange={(e) =>
                              setHeightBaseLiters(e.target.value)
                            }
                          />
                        </label>
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
                          setHeightBaseLiters("");
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
