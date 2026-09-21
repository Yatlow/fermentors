import { cloneRecipe, DEFAULT_IPA_RECIPE, type BrewRecipe } from "./brewRecipe";
import { isBrewingSandbox } from "./brewingSandbox";

const KEY = "fermentors:brewing-sandbox:recipe:ipa:v1";

export function loadSandboxRecipe(): BrewRecipe {
  if (!isBrewingSandbox()) return cloneRecipe(DEFAULT_IPA_RECIPE);
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return cloneRecipe(DEFAULT_IPA_RECIPE);
    const parsed = JSON.parse(raw) as BrewRecipe;
    if (parsed?.id !== "ipa") return cloneRecipe(DEFAULT_IPA_RECIPE);
    return {
      ...cloneRecipe(DEFAULT_IPA_RECIPE),
      ...parsed,
      mash: {
        ...cloneRecipe(DEFAULT_IPA_RECIPE).mash,
        ...(parsed.mash || {}),
      },
      lautering: {
        ...cloneRecipe(DEFAULT_IPA_RECIPE).lautering,
        ...(parsed.lautering || {}),
      },
      targets: {
        ...cloneRecipe(DEFAULT_IPA_RECIPE).targets,
        ...(parsed.targets || {}),
      },
      yeast: {
        ...cloneRecipe(DEFAULT_IPA_RECIPE).yeast,
        ...(parsed.yeast || {}),
      },
    };
  } catch {
    return cloneRecipe(DEFAULT_IPA_RECIPE);
  }
}

export function saveSandboxRecipe(recipe: BrewRecipe): BrewRecipe {
  const next = cloneRecipe(recipe);
  next.version = Math.max(1, Number(next.version || 0)) + 1;
  if (isBrewingSandbox()) {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  }
  return next;
}

export function resetSandboxRecipe(): BrewRecipe {
  const next = cloneRecipe(DEFAULT_IPA_RECIPE);
  if (isBrewingSandbox()) {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  }
  return next;
}
