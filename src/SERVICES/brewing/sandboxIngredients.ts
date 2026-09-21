import {
  DEFAULT_INGREDIENT_LIBRARY,
  type IngredientCategory,
  type IngredientDefinition,
} from "./ingredientLibrary";
import { isBrewingSandbox } from "./brewingSandbox";

const KEY = "fermentors:brewing-sandbox:ingredients:v1";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeWithDefaults(
  saved: IngredientDefinition[],
): IngredientDefinition[] {
  const byId = new Map(
    saved.map((ingredient) => [ingredient.id, clone(ingredient)]),
  );

  DEFAULT_INGREDIENT_LIBRARY.forEach((fallback) => {
    const current = byId.get(fallback.id);
    if (!current) {
      byId.set(fallback.id, clone(fallback));
      return;
    }

    const existingLots = new Map(
      (current.lots || []).map((lot) => [lot.id, lot]),
    );
    fallback.lots.forEach((lot) => {
      if (!existingLots.has(lot.id)) {
        existingLots.set(lot.id, clone(lot));
      }
    });

    byId.set(fallback.id, {
      ...fallback,
      ...current,
      lots: Array.from(existingLots.values()),
    });
  });

  return Array.from(byId.values());
}

export function loadSandboxIngredients(): IngredientDefinition[] {
  if (!isBrewingSandbox()) return clone(DEFAULT_INGREDIENT_LIBRARY);
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      const defaults = clone(DEFAULT_INGREDIENT_LIBRARY);
      window.localStorage.setItem(KEY, JSON.stringify(defaults));
      return defaults;
    }
    const parsed = JSON.parse(raw);
    const merged = Array.isArray(parsed)
      ? mergeWithDefaults(parsed)
      : clone(DEFAULT_INGREDIENT_LIBRARY);
    window.localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return clone(DEFAULT_INGREDIENT_LIBRARY);
  }
}

export function saveSandboxIngredients(
  ingredients: IngredientDefinition[],
): IngredientDefinition[] {
  const next = clone(ingredients);
  if (isBrewingSandbox()) {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  }
  return next;
}


export type CreateSandboxIngredientInput = {
  name: string;
  category: IngredientCategory;
  supplier?: string;
  lotNumber?: string;
  alpha?: number;
  bbe?: string;
};

function slugIngredient(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9א-ת_-]/g, "") ||
    `ingredient-${Date.now()}`
  );
}

export function createSandboxIngredient(
  input: CreateSandboxIngredientInput,
  baseIngredients?: IngredientDefinition[],
): {
  ingredient: IngredientDefinition;
  ingredients: IngredientDefinition[];
} {
  const current = baseIngredients
    ? clone(baseIngredients)
    : loadSandboxIngredients();
  const baseId = slugIngredient(input.name);
  let id = baseId;
  if (current.some((item) => item.id === id)) {
    id = `${baseId}-${Date.now()}`;
  }

  const ingredient: IngredientDefinition = {
    id,
    name: input.name.trim(),
    category: input.category,
    lots: [
      {
        id: `${id}-current`,
        lotNumber: input.lotNumber?.trim() || "",
        supplier: input.supplier?.trim() || undefined,
        alpha:
          input.category === "hop" &&
          Number.isFinite(Number(input.alpha))
            ? Number(input.alpha)
            : undefined,
        bbe:
          input.category === "yeast"
            ? input.bbe?.trim() || undefined
            : undefined,
        status: "current",
        active: true,
      },
    ],
  };

  const ingredients = saveSandboxIngredients([
    ...current,
    ingredient,
  ]);

  return {
    ingredient: clone(ingredient),
    ingredients,
  };
}
