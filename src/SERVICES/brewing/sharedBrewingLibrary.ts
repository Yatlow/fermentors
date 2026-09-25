import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "../../firebase";
import type { BrewRecipe } from "./brewRecipe";
import type { IngredientDefinition } from "./ingredientLibrary";

const RECIPES_DOC = "brewingRecipes";
const INGREDIENTS_DOC = "brewingIngredients";

export type SharedBrewingLibrary = {
  recipes: BrewRecipe[];
  ingredients: IngredientDefinition[];
  hasRemoteLibrary: boolean;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanForFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function loadSharedBrewingLibrary(): Promise<SharedBrewingLibrary> {
  const [recipesSnapshot, ingredientsSnapshot] = await Promise.all([
    getDoc(doc(db, "specs", RECIPES_DOC)),
    getDoc(doc(db, "specs", INGREDIENTS_DOC)),
  ]);

  const recipesData = recipesSnapshot.data() as
    | { recipes?: BrewRecipe[] }
    | undefined;
  const ingredientsData = ingredientsSnapshot.data() as
    | { ingredients?: IngredientDefinition[] }
    | undefined;

  const recipes = Array.isArray(recipesData?.recipes)
    ? clone(recipesData!.recipes!)
    : [];
  const ingredients = Array.isArray(ingredientsData?.ingredients)
    ? clone(ingredientsData!.ingredients!)
    : [];

  return {
    recipes,
    ingredients,
    hasRemoteLibrary:
      recipesSnapshot.exists() &&
      ingredientsSnapshot.exists() &&
      recipes.length > 0 &&
      ingredients.length > 0,
  };
}

function libraryMetadata() {
  return {
    schemaVersion: 1,
    updatedAt: serverTimestamp(),
    updatedBy: auth.currentUser?.uid || "",
    updatedByEmail: auth.currentUser?.email || "",
  };
}

export async function publishSharedBrewingLibrary(
  recipes: BrewRecipe[],
  ingredients: IngredientDefinition[],
): Promise<void> {
  if (!recipes.length) throw new Error("אין מתכונים לפרסום.");
  if (!ingredients.length) throw new Error("אין חומרי גלם לפרסום.");

  const batch = writeBatch(db);
  batch.set(
    doc(db, "specs", RECIPES_DOC),
    {
      ...libraryMetadata(),
      recipes: cleanForFirestore(recipes),
    },
    { merge: false },
  );
  batch.set(
    doc(db, "specs", INGREDIENTS_DOC),
    {
      ...libraryMetadata(),
      ingredients: cleanForFirestore(ingredients),
    },
    { merge: false },
  );
  await batch.commit();
}

export async function saveSharedBrewingRecipes(
  recipes: BrewRecipe[],
): Promise<void> {
  await setDoc(
    doc(db, "specs", RECIPES_DOC),
    {
      ...libraryMetadata(),
      recipes: cleanForFirestore(recipes),
    },
    { merge: false },
  );
}

export async function saveSharedBrewingIngredients(
  ingredients: IngredientDefinition[],
): Promise<void> {
  await setDoc(
    doc(db, "specs", INGREDIENTS_DOC),
    {
      ...libraryMetadata(),
      ingredients: cleanForFirestore(ingredients),
    },
    { merge: false },
  );
}
