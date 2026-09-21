export type BrewTankType = "single" | "double" | "triple";

export type BrewRecipeGrain = {
  ingredientId: string;
  kgPerBrew: number;
};

export type BrewRecipeMashStep = {
  id: string;
  label: string;
  targetTemp: number;
  minutes?: number;
};

export type BrewHopPurpose =
  | "bitterness"
  | "aroma"
  | "whirlpool"
  | "dryHop";

export type BrewRecipeHop = {
  id: string;
  ingredientId: string;
  purpose: BrewHopPurpose;
  gramsPerLiter: number;
  /** Recipe aa target is relevant only for bitterness additions. */
  aa?: number;
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
  lautering: {
    usesGrant: boolean;
  };
  targets: {
    endBoilPlato: number;
    startingPlato: number;
  };
  hops: BrewRecipeHop[];
  yeast: {
    ingredientId: string;
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
    { ingredientId: "pils", kgPerBrew: 275 },
    { ingredientId: "caramunich2", kgPerBrew: 30.6 },
  ],
  mash: {
    waterLiters: 1040,
    steps: [
      { id: "mashIn", label: "מאש אין", targetTemp: 63 },
      { id: "rest1", label: "מנוחה 1", targetTemp: 63, minutes: 30 },
      { id: "heat1", label: "חימום 1", targetTemp: 72 },
      { id: "rest2", label: "מנוחה 2", targetTemp: 72, minutes: 15 },
      { id: "heat2", label: "חימום 2", targetTemp: 78 },
      { id: "mashOut", label: "מאש אווט", targetTemp: 78 },
    ],
  },
  lautering: {
    usesGrant: false,
  },
  targets: {
    endBoilPlato: 15.45,
    startingPlato: 15.5,
  },
  hops: [
    {
      id: "cascade-bitterness",
      ingredientId: "cascade",
      purpose: "bitterness",
      aa: 6,
      gramsPerLiter: 0.581,
    },
    {
      id: "cascade-aroma",
      ingredientId: "cascade",
      purpose: "aroma",
      gramsPerLiter: 1.37,
    },
    {
      id: "cascade-whirlpool",
      ingredientId: "cascade",
      purpose: "whirlpool",
      gramsPerLiter: 1.37,
    },
    {
      id: "citra-dryhop",
      ingredientId: "citra",
      purpose: "dryHop",
      gramsPerLiter: 3,
    },
  ],
  yeast: {
    ingredientId: "s05",
    gramsPerBrew: 500,
    extraPerBatch: 0,
  },
  fermentationTemp: 21,
};

export function cloneRecipe(recipe: BrewRecipe): BrewRecipe {
  return JSON.parse(JSON.stringify(recipe)) as BrewRecipe;
}

export function createEmptyRecipe(
  id: string,
  style: string,
): BrewRecipe {
  return {
    id,
    style,
    version: 1,
    allowedTankTypes: ["single", "double", "triple"],
    grains: [],
    mash: {
      waterLiters: 0,
      steps: [
        { id: "mashIn", label: "מאש אין", targetTemp: 63 },
        {
          id: "rest1",
          label: "מנוחה 1",
          targetTemp: 0,
          minutes: 0,
        },
        {
          id: "heat1",
          label: "חימום 1",
          targetTemp: 78,
        },
        { id: "mashOut", label: "מאש אווט", targetTemp: 78 },
      ],
    },
    lautering: { usesGrant: false },
    targets: { endBoilPlato: 0, startingPlato: 0 },
    hops: [],
    yeast: {
      ingredientId: "",
      gramsPerBrew: 0,
      extraPerBatch: 0,
    },
    fermentationTemp: 0,
  };
}
