import type { BrewRecipe } from "./brewRecipe";

export type BrewRun = {
  batchNumber: string;
  tankId: string;
  tankNumber: string;
  tankType: "single" | "double" | "triple";
  style: string;
  brewDate?: string;
  createdAt: string;
  source: "production";
  started: boolean;
  action?: string | number | null;
  brewSheetEditRevision?: number | null;
  brewSheetEditRange?: string | null;
  brewSheetEditValue?: string | null;
  brewSheetEditOldValue?: string | null;
  brewSheetEditSheetName?: string | null;
  brewProgress?: {
    blockIndex?: number | null;
    stageName?: string | null;
    stageStartTimeText?: string | null;
    stageEndTimeText?: string | null;
  } | null;
  sheetId?: string;
  sheetUrl?: string;
  sheetName?: string;
  recipeSnapshot?: BrewRecipe;
  assignmentStatus?: "assigned" | "pending_sanitization";
};
