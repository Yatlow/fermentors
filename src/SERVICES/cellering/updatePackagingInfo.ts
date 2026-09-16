export type PackagingEntry = {
    tankId: string | number;
    tankNumber?: string | number;
    sheetUrl: string | null;
    isEmpty?: boolean;
    kegs?: string | number;
    crates?: string | number; // בפועל: כמות בקבוקים
    totalLiters?: number;
    shrinkagePercent?: number;
};

export type updatePackagingResult = {
    success: boolean;
    tankId: string | number;
    message?: string;
    error?: string;
    [key: string]: unknown;
};

/**
 * Compatibility wrapper for SendMessurmentsHeader.
 *
 * Packaging sheet cells are now sent in parallel from writeReadingsToSheets(),
 * together with the fermentation-row write. The old flow called this function
 * only AFTER that first request completed, creating an unnecessary second
 * sequential Apps Script wait. Keep the function so the component API does not
 * need a risky large refactor, but do not send the same mutation twice.
 */
export async function updatePackagingInfo(
    entries: PackagingEntry[]
): Promise<updatePackagingResult[]> {
    return entries.map((entry) => ({
        success: true,
        tankId: entry.tankId,
        tankNumber: entry.tankNumber,
        alreadySynced: true,
    }));
}
