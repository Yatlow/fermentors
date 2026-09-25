import {
  cloneRecipe,
  createEmptyRecipe,
  DEFAULT_IPA_RECIPE,
  type BrewRecipe,
} from "./brewRecipe";

const LEGACY_IPA_KEY = "fermentors:brewing:recipe:ipa:v1";
const KEY = "fermentors:brewing:recipes:v2";

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

function normalizeMashSteps(rawSteps: any[], fallbackSteps: any[]) {
  const source = rawSteps.length ? rawSteps : fallbackSteps;
  const mashIn =
    source.find((step) => step?.id === "mashIn") ||
    source[0] ||
    fallbackSteps[0];
  const mashOut =
    source.find((step) => step?.id === "mashOut") ||
    source[source.length - 1] ||
    fallbackSteps[fallbackSteps.length - 1];

  const middle = source.filter(
    (step) =>
      step !== mashIn &&
      step !== mashOut &&
      step?.id !== "mashIn" &&
      step?.id !== "mashOut",
  );

  const looksLikeHeat = (step: any) =>
    /^heat/i.test(String(step?.id || "")) ||
    /חימום/.test(String(step?.label || ""));

  const rests = middle.filter((step) => !looksLikeHeat(step));
  const heats = middle.filter(looksLikeHeat);

  const paired = rests.flatMap((rest, index) => {
    const existingHeat = heats[index];
    const nextRest = rests[index + 1];
    const heatTarget = Number(
      nextRest?.targetTemp ??
        mashOut?.targetTemp ??
        existingHeat?.targetTemp ??
        78,
    );

    return [
      {
        ...rest,
        id: `rest${index + 1}`,
        label: `מנוחה ${index + 1}`,
      },
      {
        ...(existingHeat || {}),
        id: `heat${index + 1}`,
        label: `חימום ${index + 1}`,
        targetTemp: Number.isFinite(heatTarget) ? heatTarget : 0,
        minutes: undefined,
      },
    ];
  });

  return [
    {
      ...mashIn,
      id: "mashIn",
      label: "מאש אין",
      targetTemp: Number(rests[0]?.targetTemp ?? mashIn?.targetTemp ?? 63),
      minutes: undefined,
    },
    ...paired,
    {
      ...mashOut,
      id: "mashOut",
      label: "מאש אווט",
      targetTemp: Number(mashOut?.targetTemp || 78),
      minutes: undefined,
    },
  ];
}
function normalizeRecipe(raw: any): BrewRecipe {
  const fallback =
    raw?.id === "ipa"
      ? cloneRecipe(DEFAULT_IPA_RECIPE)
      : createEmptyRecipe(
          String(raw?.id || "recipe"),
          String(raw?.style || "מתכון"),
        );

  const rawSteps = Array.isArray(raw?.mash?.steps)
    ? raw.mash.steps
    : fallback.mash.steps;
  const normalizedMashSteps = normalizeMashSteps(
    rawSteps,
    fallback.mash.steps,
  );

  const normalizeHopPurpose = (hop: any) => {
    if (hop?.purpose) return hop.purpose;
    if (hop?.phase === "dryHop") return "dryHop";
    if (hop?.phase === "flameout") return "whirlpool";
    if (hop?.phase === "boil") {
      const minutes = Number(hop?.minutesFromEnd);
      if (Number.isFinite(minutes) && minutes <= 0) {
        return "whirlpool";
      }
      if (Number.isFinite(minutes) && minutes <= 20) {
        return "aroma";
      }
      return "bitterness";
    }
    return "aroma";
  };

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
      steps: normalizedMashSteps,
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
      ? raw.hops.map((hop: any, index: number) => {
          const purpose = normalizeHopPurpose(hop);
          return {
            id: String(hop.id || `hop-${index + 1}`),
            ingredientId:
              hop.ingredientId ||
              ingredientIdFromLegacyName(hop.name),
            purpose,
            gramsPerLiter: Number(hop.gramsPerLiter || 0),
            ...(purpose !== "dryHop"
              ? {
                  boilMinutes:
                    hop.boilMinutes !== undefined
                      ? Number(hop.boilMinutes)
                      : hop.minutesFromEnd !== undefined
                        ? Number(hop.minutesFromEnd)
                        : purpose === "whirlpool"
                          ? 0
                          : undefined,
                }
              : {}),
            ...(purpose === "bitterness"
              ? {
                  aa:
                    hop.aa !== undefined
                      ? Number(hop.aa)
                      : hop.referenceAlpha !== undefined
                        ? Number(hop.referenceAlpha)
                        : undefined,
                }
              : {}),
          };
        })
      : fallback.hops,
    yeast: {
      ...fallback.yeast,
      ...(raw?.yeast || {}),
      ingredientId:
        raw?.yeast?.ingredientId ||
        ingredientIdFromLegacyName(
          raw?.yeast?.name || fallback.yeast.ingredientId,
        ),
    },
  };
}

function persist(recipes: BrewRecipe[]) {
  window.localStorage.setItem(KEY, JSON.stringify(recipes));
}

export function replaceRecipes(recipes: BrewRecipe[]): BrewRecipe[] {
  const next = recipes.map((recipe) => normalizeRecipe(cloneRecipe(recipe)));
  persist(next);
  return next.map(cloneRecipe);
}

export function loadRecipes(): BrewRecipe[] {
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

export function loadRecipe(id = "ipa"): BrewRecipe {
  const recipes = loadRecipes();
  return cloneRecipe(
    recipes.find((recipe) => recipe.id === id) ||
      recipes.find((recipe) => recipe.id === "ipa") ||
      DEFAULT_IPA_RECIPE,
  );
}

export function saveRecipe(recipe: BrewRecipe): BrewRecipe {
  const next = normalizeRecipe(cloneRecipe(recipe));
  next.version = Math.max(1, Number(next.version || 0)) + 1;

  const recipes = loadRecipes();
  const exists = recipes.some((item) => item.id === next.id);
  const updated = exists
    ? recipes.map((item) => (item.id === next.id ? next : item))
    : [...recipes, next];
  persist(updated);
  return cloneRecipe(next);
}

export function createRecipe(style: string): BrewRecipe {
  const cleanStyle = style.trim() || "מתכון חדש";
  let id = slug(cleanStyle) || `recipe-${Date.now()}`;
  const recipes = loadRecipes();
  if (recipes.some((recipe) => recipe.id === id)) {
    id = `${id}-${Date.now()}`;
  }
  const recipe = createEmptyRecipe(id, cleanStyle);
  persist([...recipes, recipe]);
  return cloneRecipe(recipe);
}

export function resetRecipe(id = "ipa"): BrewRecipe {
  if (id !== "ipa") {
    const recipes = loadRecipes();
    const existing = recipes.find((recipe) => recipe.id === id);
    const next = createEmptyRecipe(id, existing?.style || "מתכון");
    persist(recipes.map((recipe) => (recipe.id === id ? next : recipe)));
    return cloneRecipe(next);
  }

  const next = cloneRecipe(DEFAULT_IPA_RECIPE);
  const recipes = loadRecipes();
  const exists = recipes.some((recipe) => recipe.id === "ipa");
  persist(
    exists
      ? recipes.map((recipe) => (recipe.id === "ipa" ? next : recipe))
      : [next, ...recipes],
  );
  return cloneRecipe(next);
}


export function deleteRecipe(id: string): boolean {
  const recipes = loadRecipes();
  const next = recipes.filter((recipe) => recipe.id !== id);
  if (next.length === recipes.length) return false;
  persist(next);
  return true;
}
