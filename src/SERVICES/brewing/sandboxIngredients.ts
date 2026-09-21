import {
  DEFAULT_INGREDIENT_LIBRARY,
  type IngredientDefinition,
} from "./ingredientLibrary";
import { isBrewingSandbox } from "./brewingSandbox";

const KEY = "fermentors:brewing-sandbox:ingredients:v1";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function loadSandboxIngredients(): IngredientDefinition[] {
  if (!isBrewingSandbox()) return clone(DEFAULT_INGREDIENT_LIBRARY);
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_INGREDIENT_LIBRARY);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : clone(DEFAULT_INGREDIENT_LIBRARY);
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
