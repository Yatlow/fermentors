import { calculateWeightedStartingPlato } from "./startingPlato";

// The calculator's destination is captured when it opens. Never infer the
// destination from the currently selected A/B/C block when "Use result" fires.
export const HYDROMETER_SHEET_FIELDS = [
  "frPlato",
  "lrPlato",
  "kettlePlato",
  "endBoilPlato",
  "fermentorSamplePlato",
] as const;
export type HydrometerField = typeof HYDROMETER_SHEET_FIELDS[number] | "boilSamplePlato";
export type HydrometerDestination = {
  batchNumber: string;
  blockIndex: number;
  field: HydrometerField;
};

export type HydrometerExecution = {
  batchNumber: string;
  activeBlockIndex: number;
  blocks: Record<string, { fields: Record<string, string> }>;
};
export type HydrometerWrite = { range: string; value: number };

const isSheetField = (field: HydrometerField): field is typeof HYDROMETER_SHEET_FIELDS[number] =>
  HYDROMETER_SHEET_FIELDS.some((known) => known === field);

function numeric(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sheetRow(fields: Record<string, string>, key: string): number {
  const row = Number(fields[key]);
  if (!Number.isSafeInteger(row) || row <= 0) {
    throw new Error("חסר מיפוי סמנטי לשדה. יש לרענן את טופס הבישול לפני שימוש בתוצאה.");
  }
  return row;
}

/** Pure, all-or-nothing update: ensure row mappings before changing state.
 * Keeps unrelated fields, brew blocks and the active navigation position.
 */
export function applyHydrometerResult<T extends HydrometerExecution>(
  execution: T,
  destination: HydrometerDestination,
  correctedPlato: number,
  options: { sheetBacked: boolean; totalBlocks: number },
): { nextExecution: T; writes: HydrometerWrite[]; value: string } {
  if (execution.batchNumber !== destination.batchNumber ||
      destination.blockIndex < 1 || destination.blockIndex > options.totalBlocks ||
      !Number.isInteger(destination.blockIndex)) {
    throw new Error("אצווה או בישול לא תואמים למחשבון שנפתח.");
  }
  if (!Number.isFinite(correctedPlato)) throw new Error("תוצאת הידרומטר אינה תקינה.");
  const value = correctedPlato.toFixed(2);
  const previousFields = execution.blocks[String(destination.blockIndex)]?.fields || {};
  const writes: HydrometerWrite[] = [];

  if (isSheetField(destination.field) && options.sheetBacked) {
    const row = sheetRow(previousFields, `__sheetRow.sugar.${destination.field}`);
    writes.push({ range: `'גיליון1'!B${row}`, value: Number(value) });
  }

  const nextExecution = {
    ...execution,
    blocks: {
      ...execution.blocks,
      [String(destination.blockIndex)]: {
        ...execution.blocks[String(destination.blockIndex)],
        fields: { ...previousFields, [destination.field]: value },
      },
    },
  } as T;

  if (destination.field === "endBoilPlato" && options.sheetBacked) {
    const weighted = calculateWeightedStartingPlato(
      Array.from({ length: options.totalBlocks }, (_, index) => {
        const fields = nextExecution.blocks[String(index + 1)]?.fields || {};
        return {
          endBoilPlato: numeric(fields.endBoilPlato),
          endBoilVolumeLiters: numeric(fields.endBoilVolume),
        };
      }),
    );
    if (weighted.value !== null) {
      const row = sheetRow(previousFields, "__sheetRow.fermentation");
      writes.push({ range: `'גיליון1'!D${row}`, value: Number(weighted.value.toFixed(2)) });
    }
  }
  return { nextExecution, writes, value };
}
