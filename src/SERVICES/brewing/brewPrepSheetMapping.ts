/**
 * Locate brew preparation targets from the live Sheet rather than cached
 * offsets. The top-level title is not a brew header; a genuine A/B/C header
 * must contain the exact batch+letter along with "סוג:" and "אצווה:".
 * Never guess row positions on copied/extended three-rest templates.
 */
export type BrewPrepSheetTargets = {
    headerRow: number;
    hltRow: number | null;
    mashWaterRow: number | null;
    fermentationRow: number | null;
};

const compact = (value: unknown) => String(value ?? "").replace(/\s+/g, "").toUpperCase();
const label = (value: unknown) => String(value ?? "").trim();

export function resolveBrewPrepSheetTargets(
    rows: readonly (readonly unknown[])[],
    batchNumber: string | number,
    blockIndex: number,
    required: "water" | "date",
): BrewPrepSheetTargets {
    const batch = String(batchNumber).replace(/^#/, "").trim();
    if (!/^\d{3,6}$/.test(batch) || !Number.isInteger(blockIndex) ||
        blockIndex < 1 || blockIndex > 3) {
        throw new Error("Invalid batch/block identity for brew Sheet mapping");
    }
    const expected = `${batch}${String.fromCharCode(64 + blockIndex)}`;
    const headers = rows.flatMap((row, index) => {
        const cells = row.map(label);
        const isBrewHeader = cells.some(cell => /^(?:סוג(?:\s+בירה)?|סגנון)\s*:?$/i.test(cell)) &&
            cells.some(cell => /^אצווה\s*:?$/i.test(cell));
        return isBrewHeader && cells.some(cell => compact(cell) === expected) ? [index] : [];
    });
    if (headers.length !== 1) {
        throw new Error(`לא נמצאה כותרת ייחודית לבישול ${expected} בגיליון (${headers.length} התאמות).`);
    }
    const header = headers[0];
    const nextHeader = rows.findIndex((row, index) => index > header &&
        row.some(cell => /^אצווה\s*:?$/i.test(label(cell))) &&
        row.some(cell => /^(?:סוג(?:\s+בירה)?|סגנון)\s*:?$/i.test(label(cell))) &&
        row.some(cell => new RegExp(`^${batch}[ABC]$`, "i").test(compact(cell))));
    const fermentationCandidates = rows.flatMap((row, index) =>
        /^יום\s*בישול/i.test(label(row[0])) &&
        /^סוכר\s*תחילי/i.test(label(row[2])) &&
        /שעת\s*הוספת\s*שמרים/i.test(label(row[4])) ? [index] : [],
    );
    const fermentationRow = fermentationCandidates.length === 1
        ? fermentationCandidates[0] + 1 : null;
    const end = Math.min(
        nextHeader < 0 ? rows.length : nextHeader,
        fermentationRow !== null ? fermentationRow - 1 : rows.length,
    );
    const matchingWaterRow = (name: string) => {
        const matches = rows.flatMap((row, index) =>
            index > header && index < end && compact(row[0]) === name ? [index] : [],
        );
        return matches.length === 1 ? matches[0] + 1 : null;
    };
    const hltRow = matchingWaterRow("HLT");
    const mashWaterRow = matchingWaterRow("MASHIN");
    if (required === "water" && (!hltRow || !mashWaterRow)) {
        throw new Error(`מיפוי המים לבישול ${expected} אינו חד-משמעי (HLT/MASH IN).`);
    }
    if (required === "date" && blockIndex === 1 && fermentationRow === null) {
        throw new Error("לא אותרה שורת יום בישול ייחודית בדף התסיסה.");
    }
    return { headerRow: header + 1, hltRow, mashWaterRow, fermentationRow };
}
