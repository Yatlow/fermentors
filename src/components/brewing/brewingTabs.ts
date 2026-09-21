export type BrewingTab = "create" | "recipes" | "form";

export const BREWING_TABS: ReadonlyArray<readonly [BrewingTab, string]> = [
    ["create", "יצירת בישול חדש"],
    ["recipes", "עריכת מתכונים"],
    ["form", "מילוי טופס בישול"],
];
