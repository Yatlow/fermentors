import {
  cloneRecipe,
  createEmptyRecipe,
  DEFAULT_IPA_RECIPE,
  type BrewRecipe,
} from "./brewRecipe";
import { isBrewingSandbox } from "./brewingSandbox";

const LEGACY_IPA_KEY = "fermentors:brewing-sandbox:recipe:ipa:v1";
const KEY = "fermentors:brewing-sandbox:recipes:v2";

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9א-ת_-]/g, "");
}

function ingredientIdFromLegacyName(value: unknown): string {
  const name = String(value || "").trim().toLowerCase();
  if (name.includes("pils")) return "pils";
  if (name.includes("caramunich")) return "caramunich2";
  if (name.includes("cascade")) return "cascade";
  if (name.includes("citra")) return "citra";
  if (name.includes("s-05") || name.includes("s05")) return "s05";
  return slug(name) || "ingredient";
}

function normalizeRecipe(raw: any): BrewRecipe {
  const fallback = raw?.id === "ipa" ? cloneRecipe(DEFAULT_IPA_RECIPE) : createEmptyRecipe(
    String(raw?.id || "recipe"),
    String(raw?.style || "מתכון"),
  );

  return {
    ...fallback,
    ...raw,
    grains: Array.isArray(raw?.grains)
      ? raw.grains.map((grain: any) => ({
          ingredientId:
            grain.ingredientId ||
            ingredientIdFromLegacyName(grain.name || grain.id),
          kgPerBrew: Number(grain.kgPerBrew || 0),
        }))
      : fallback.grains,
    mash: {
      ...fallback.mash,
      ...(raw?.mash || {}),
      steps: Array.isArray(raw?.mash?.steps)
        ? raw.mash.steps
        : fallback.mash.steps,
    },
    lautering: {
      ...fallback.lautering,
      ...(raw?.lautering || {}),
    },
    targets: {
      ...fallback.targets,
      ...(raw?.targets || {}),
    },
    hops: Array.isArray(raw?.hops)
      ? raw.hops.map((hop: any, index: number) => ({
          ...hop,
          id: String(hop.id || `hop-${index + 1}`),
          ingredientId:
            hop.ingredientId || ingredientIdFromLegacyName(hop.name),
        }))
      : fallback.hops,
    yeast: {
      ...fallback.yeast,
      ...(raw?.yeast || {}),
      ingredientId:
        raw?.yeast?.ingredientId ||
        ingredientIdFromLegacyName(raw?.yeast?.name || fallback.yeast.ingredientId),
    },
  };
}

function persist(recipes: BrewRecipe[]) {
  if (isBrewingSandbox()) {
    window.localStorage.setItem(KEY, JSON.stringify(recipes));
  }
}

export function loadSandboxRecipes(): BrewRecipe[] {
  if (!isBrewingSandbox()) return [cloneRecipe(DEFAULT_IPA_RECIPE)];

  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map(normalizeRecipe);
      }
    }

    const legacy = window.localStorage.getItem(LEGACY_IPA_KEY);
    const ipa = legacy
      ? normalizeRecipe(JSON.parse(legacy))
      : cloneRecipe(DEFAULT_IPA_RECIPE);
    const recipes = [ipa];
    persist(recipes);
    return recipes;
  } catch {
    return [cloneRecipe(DEFAULT_IPA_RECIPE)];
  }
}

export function loadSandboxRecipe(id = "ipa"): BrewRecipe {
  const recipes = loadSandboxRecipes();
  return cloneRecipe(
    recipes.find((recipe) => recipe.id === id) ||
      recipes.find((recipe) => recipe.id === "ipa") ||
      DEFAULT_IPA_RECIPE,
  );
}

export function saveSandboxRecipe(recipe: BrewRecipe): BrewRecipe {
  const next = normalizeRecipe(cloneRecipe(recipe));
  next.version = Math.max(1, Number(next.version || 0)) + 1;

  const recipes = loadSandboxRecipes();
  const exists = recipes.some((item) => item.id === next.id);
  const updated = exists
    ? recipes.map((item) => (item.id === next.id ? next : item))
    : [...recipes, next];
  persist(updated);
  return cloneRecipe(next);
}

export function createSandboxRecipe(style: string): BrewRecipe {
  const cleanStyle = style.trim() || "מתכון חדש";
  let id = slug(cleanStyle) || `recipe-${Date.now()}`;
  const recipes = loadSandboxRecipes();
  if (recipes.some((recipe) => recipe.id === id)) {
    id = `${id}-${Date.now()}`;
  }
  const recipe = createEmptyRecipe(id, cleanStyle);
  persist([...recipes, recipe]);
  return cloneRecipe(recipe);
}

export function resetSandboxRecipe(id = "ipa"): BrewRecipe {
  if (id !== "ipa") {
    const recipes = loadSandboxRecipes();
    const existing = recipes.find((recipe) => recipe.id === id);
    const next = createEmptyRecipe(id, existing?.style || "מתכון");
    persist(recipes.map((recipe) => (recipe.id === id ? next : recipe)));
    return cloneRecipe(next);
  }

  const next = cloneRecipe(DEFAULT_IPA_RECIPE);
  const recipes = loadSandboxRecipes();
  const exists = recipes.some((recipe) => recipe.id === "ipa");
  persist(
    exists
      ? recipes.map((recipe) => (recipe.id === "ipa" ? next : recipe))
      : [next, ...recipes],
  );
  return cloneRecipe(next);
}
