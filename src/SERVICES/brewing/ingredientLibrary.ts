export type IngredientCategory = "grain" | "hop" | "yeast" | "other";

export type IngredientLot = {
  id: string;
  lotNumber: string;
  supplier?: string;
  alpha?: number;
  bbe?: string;
  active: boolean;
};

export type IngredientDefinition = {
  id: string;
  name: string;
  category: IngredientCategory;
  lots: IngredientLot[];
};

export const DEFAULT_INGREDIENT_LIBRARY: IngredientDefinition[] = [
  {
    id: "pils",
    name: "Pils",
    category: "grain",
    lots: [{ id: "pils-current", lotNumber: "", supplier: "Avangard", active: true }],
  },
  {
    id: "caramunich2",
    name: "Caramunich2",
    category: "grain",
    lots: [{ id: "caramunich2-current", lotNumber: "", supplier: "Weyermann", active: true }],
  },
  {
    id: "cascade",
    name: "Cascade",
    category: "hop",
    lots: [{ id: "cascade-current", lotNumber: "", alpha: 6, active: true }],
  },
  {
    id: "citra",
    name: "Citra",
    category: "hop",
    lots: [{ id: "citra-current", lotNumber: "", alpha: 13.8, active: true }],
  },
  {
    id: "s05",
    name: "S-05",
    category: "yeast",
    lots: [{ id: "s05-current", lotNumber: "", active: true }],
  },
];

export function activeLot(ingredient: IngredientDefinition): IngredientLot | undefined {
  return ingredient.lots.find((lot) => lot.active) ?? ingredient.lots[0];
}
