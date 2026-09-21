export type BrewTankType = "single" | "double" | "triple";

export type BrewRecipeGrain = {
  id: string;
  name: string;
  supplier: string;
  kgPerBrew: number;
};

export type BrewRecipeMashStep = {
  id: string;
  label: string;
  targetTemp: number;
  minutes?: number;
};

export type BrewRecipeHop = {
  id: string;
  name: string;
  phase: "boil" | "flameout" | "dryHop";
  referenceAlpha: number;
  gramsPerLiter: number;
  minutesFromEnd?: number;
  daysAfterBrew?: number;
};

export type BrewRecipe = {
  id: string;
  style: string;
  version: number;
  allowedTankTypes: BrewTankType[];
  grains: BrewRecipeGrain[];
  mash: {
    waterLiters: number;
    steps: BrewRecipeMashStep[];
  };
  targets: {
    endBoilPlato: number;
    startingPlato: number;
  };
  hops: BrewRecipeHop[];
  yeast: {
    name: string;
    gramsPerBrew: number;
    extraPerBatch: number;
  };
  fermentationTemp: number;
};

export const DEFAULT_IPA_RECIPE: BrewRecipe = {
  id: "ipa",
  style: "IPA",
  version: 1,
  allowedTankTypes: ["single", "double", "triple"],
  grains: [
    { id: "pils-avangard", name: "Pils", supplier: "Avangard", kgPerBrew: 275 },
    { id: "caramunich2-weyermann", name: "Caramunich2", supplier: "Weyermann", kgPerBrew: 30.6 },
  ],
  mash: {
    waterLiters: 1040,
    steps: [
      { id: "mashIn", label: "מאש אין", targetTemp: 63 },
      { id: "rest1", label: "מנוחה 1", targetTemp: 63, minutes: 30 },
      { id: "rest2", label: "מנוחה 2", targetTemp: 72, minutes: 15 },
      { id: "mashOut", label: "סוף מאש", targetTemp: 78 },
    ],
  },
  targets: {
    endBoilPlato: 15.45,
    startingPlato: 15.5,
  },
  hops: [
    {
      id: "cascade-60",
      name: "Cascade",
      phase: "boil",
      referenceAlpha: 6,
      gramsPerLiter: 0.581,
      minutesFromEnd: 60,
    },
    {
      id: "cascade-10",
      name: "Cascade",
      phase: "boil",
      referenceAlpha: 6,
      gramsPerLiter: 1.37,
      minutesFromEnd: 10,
    },
    {
      id: "cascade-flameout",
      name: "Cascade",
      phase: "flameout",
      referenceAlpha: 6,
      gramsPerLiter: 1.37,
      minutesFromEnd: 0,
    },
    {
      id: "citra-dryhop",
      name: "Citra",
      phase: "dryHop",
      referenceAlpha: 13.8,
      gramsPerLiter: 3,
      daysAfterBrew: 3,
    },
  ],
  yeast: {
    name: "S-05",
    gramsPerBrew: 500,
    extraPerBatch: 0,
  },
  fermentationTemp: 21,
};

export function cloneRecipe(recipe: BrewRecipe): BrewRecipe {
  return JSON.parse(JSON.stringify(recipe)) as BrewRecipe;
}
