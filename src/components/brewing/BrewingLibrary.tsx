import { useEffect, useMemo, useState } from "react";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
  createRecipe as createStoredRecipe,
  deleteRecipe,
  saveRecipe as saveStoredRecipe,
} from "../../SERVICES/brewing/recipeEditorStore";
import {
  activeLot,
  type IngredientCategory,
  type IngredientDefinition,
  type IngredientLotStatus,
} from "../../SERVICES/brewing/ingredientLibrary";
import {
  createIngredient as createStoredIngredient,
  saveIngredients,
  type CreateIngredientInput,
} from "../../SERVICES/brewing/ingredientEditorStore";
import BrewRecipeEditor from "./BrewRecipeEditor";
import IngredientLotsModal from "./IngredientLotsModal";

type Props = {
  recipes: BrewRecipe[];
  ingredients: IngredientDefinition[];
  onRecipesChange: (recipes: BrewRecipe[]) => void;
  onIngredientsChange: (ingredients: IngredientDefinition[]) => void;
  sharedLibraryReady?: boolean;
  publishingSharedLibrary?: boolean;
  onPublishSharedLibrary?: () => void;
};

type LibrarySection = "recipes" | "ingredients";

const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  grain: "לתת",
  hop: "כשות",
  yeast: "שמרים",
  other: "אחר",
};

export default function BrewingLibrary({
  recipes,
  ingredients,
  onRecipesChange,
  onIngredientsChange,
  sharedLibraryReady = false,
  publishingSharedLibrary = false,
  onPublishSharedLibrary,
}: Props) {
  const [section, setSection] = useState<LibrarySection>("recipes");
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [showNewRecipe, setShowNewRecipe] = useState(false);
  const [newRecipeName, setNewRecipeName] = useState("");
  const [showNewIngredient, setShowNewIngredient] = useState(false);
  const [newIngredientName, setNewIngredientName] = useState("");
  const [newIngredientCategory, setNewIngredientCategory] =
    useState<IngredientCategory>("grain");
  const [message, setMessage] = useState("");
  const [deleteRecipeId, setDeleteRecipeId] = useState<string | null>(null);
  const [deleteLotKey, setDeleteLotKey] = useState<string | null>(null);
  const [lotsIngredientId, setLotsIngredientId] = useState<string | null>(null);

  useEffect(() => {
    saveIngredients(ingredients);
  }, [ingredients]);

  function updateIngredients(
    updater: (current: IngredientDefinition[]) => IngredientDefinition[],
  ) {
    const next = updater(ingredients);
    saveIngredients(next);
    onIngredientsChange(next);
  }

  const selectedRecipe = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedRecipeId) || null,
    [recipes, selectedRecipeId],
  );

  function saveRecipe(recipe: BrewRecipe) {
    const saved = saveStoredRecipe(recipe);
    const next = recipes.some((item) => item.id === saved.id)
      ? recipes.map((item) => (item.id === saved.id ? saved : item))
      : [...recipes, saved];
    setSelectedRecipeId(null);
    onRecipesChange(next);
    setMessage(`${saved.style} נשמר כגרסה ${saved.version}.`);
  }

  function createRecipe() {
    const name = newRecipeName.trim();
    if (!name) return;
    const created = createStoredRecipe(name);
    const next = [...recipes.filter((item) => item.id !== created.id), created];
    onRecipesChange(next);
    setNewRecipeName("");
    setShowNewRecipe(false);
    setSelectedRecipeId(created.id);
    setMessage("");
  }

  function removeRecipe(recipe: BrewRecipe) {
    if (deleteRecipeId !== recipe.id) {
      setDeleteRecipeId(recipe.id);
      return;
    }
    deleteRecipe(recipe.id);
    const next = recipes.filter((item) => item.id !== recipe.id);
    onRecipesChange(next);
    setDeleteRecipeId(null);
    setMessage(`${recipe.style} נמחק מספריית המתכונים. אצוות קיימות לא משתנות.`);
  }

  function updateIngredient(
    ingredientId: string,
    field: "name" | "supplier" | "lotNumber" | "alpha" | "bbe",
    value: string,
  ) {
    updateIngredients((current) =>
      current.map((ingredient) => {
        if (ingredient.id !== ingredientId) return ingredient;
        if (field === "name") return { ...ingredient, name: value };

        const lots = ingredient.lots.length
          ? ingredient.lots
          : [
              {
                id: `${ingredient.id}-current`,
                lotNumber: "",
                active: true,
              },
            ];

        const selectedLot = activeLot(ingredient);
        let activeIndex = lots.findIndex(
          (lot) => lot.id === selectedLot?.id,
        );
        if (activeIndex < 0) activeIndex = 0;

        return {
          ...ingredient,
          lots: lots.map((lot, index) =>
            index === activeIndex
              ? {
                  ...lot,
                  ...(field === "supplier" ? { supplier: value } : {}),
                  ...(field === "lotNumber" ? { lotNumber: value } : {}),
                  ...(field === "alpha"
                    ? {
                        alpha:
                          value === "" || !Number.isFinite(Number(value))
                            ? undefined
                            : Number(value),
                      }
                    : {}),
                  ...(field === "bbe" ? { bbe: value } : {}),
                }
              : lot,
          ),
        };
      }),
    );
    setMessage("");
  }

  function createIngredientFromInput(
    input: CreateIngredientInput,
  ): IngredientDefinition {
    const result = createStoredIngredient(input, ingredients);
    saveIngredients(result.ingredients);
    onIngredientsChange(result.ingredients);
    setMessage(`${result.ingredient.name} נוסף לספריית חומרי הגלם.`);
    return result.ingredient;
  }

  function createIngredient() {
    const name = newIngredientName.trim();
    if (!name) return;

    createIngredientFromInput({
      name,
      category: newIngredientCategory,
    });
    setNewIngredientName("");
    setShowNewIngredient(false);
  }

  function updateIngredientLot(
    ingredientId: string,
    lotId: string,
    field:
      | "supplier"
      | "lotNumber"
      | "alpha"
      | "bbe"
      | "receivedDate"
      | "startedDate",
    value: string,
  ) {
    updateIngredients((current) =>
      current.map((ingredient) =>
        ingredient.id !== ingredientId
          ? ingredient
          : {
              ...ingredient,
              lots: ingredient.lots.map((lot) =>
                lot.id !== lotId
                  ? lot
                  : {
                      ...lot,
                      ...(field === "supplier"
                        ? { supplier: value }
                        : {}),
                      ...(field === "lotNumber"
                        ? { lotNumber: value }
                        : {}),
                      ...(field === "alpha"
                        ? {
                            alpha:
                              value === "" ||
                              !Number.isFinite(Number(value))
                                ? undefined
                                : Number(value),
                          }
                        : {}),
                      ...(field === "bbe" ? { bbe: value } : {}),
                      ...(field === "receivedDate"
                        ? { receivedDate: value }
                        : {}),
                      ...(field === "startedDate"
                        ? { startedDate: value }
                        : {}),
                    },
              ),
            },
      ),
    );
    setMessage("");
  }

  function setIngredientLotStatus(
    ingredientId: string,
    lotId: string,
    status: IngredientLotStatus,
  ) {
    updateIngredients((current) =>
      current.map((ingredient) => {
        if (ingredient.id !== ingredientId) return ingredient;

        return {
          ...ingredient,
          lots: ingredient.lots.map((lot) => {
            if (lot.id === lotId) {
              return {
                ...lot,
                status,
                active: status === "current",
              };
            }

            if (status === "current" && lot.active) {
              return {
                ...lot,
                active: false,
                status:
                  lot.status === "current"
                    ? "next"
                    : lot.status,
              };
            }

            return lot;
          }),
        };
      }),
    );
    setMessage("");
  }

  function addIngredientLot(ingredientId: string) {
    updateIngredients((current) =>
      current.map((ingredient) =>
        ingredient.id !== ingredientId
          ? ingredient
          : {
              ...ingredient,
              lots: [
                ...ingredient.lots,
                {
                  id: `${ingredient.id}-lot-${Date.now()}`,
                  lotNumber: "",
                  status: "next",
                  active: false,
                },
              ],
            },
      ),
    );
    setMessage("");
  }

  function deleteIngredientLot(
    ingredientId: string,
    lotId: string,
  ) {
    const key = `${ingredientId}:${lotId}`;
    if (deleteLotKey !== key) {
      setDeleteLotKey(key);
      return;
    }

    const source = ingredients.find(
      (ingredient) => ingredient.id === ingredientId,
    );
    const removesIngredient = source?.lots.length === 1;

    updateIngredients((current) =>
      current.flatMap((ingredient) => {
        if (ingredient.id !== ingredientId) return [ingredient];

        const remainingLots = ingredient.lots.filter(
          (lot) => lot.id !== lotId,
        );

        return remainingLots.length === 0
          ? []
          : [{ ...ingredient, lots: remainingLots }];
      }),
    );

    setDeleteLotKey(null);
    if (removesIngredient) setLotsIngredientId(null);
    setMessage(
      removesIngredient
        ? `${source?.name || "חומר הגלם"} נמחק כי לא נשארו לו אצוות.`
        : "אצוות חומר הגלם נמחקה.",
    );
  }

  if (selectedRecipe) {
    return (
      <BrewRecipeEditor
        recipe={selectedRecipe}
        ingredients={ingredients}
        onSave={saveRecipe}
        onBack={() => setSelectedRecipeId(null)}
        onCreateIngredient={createIngredientFromInput}
      />
    );
  }

  return (
    <section className="brewing-library">
      {onPublishSharedLibrary && !sharedLibraryReady && (
        <div className="brew-library-share-status pending">
          <div>
            <strong>הספרייה עדיין מקומית למכשיר הזה</strong>
            <span>
              בצע פרסום חד־פעמי מהמכשיר שבו הספרייה המעודכנת נמצאת.
            </span>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={publishingSharedLibrary}
            onClick={onPublishSharedLibrary}
          >
            {publishingSharedLibrary ? "שומר…" : "סנכרן ספרייה"}
          </button>
        </div>
      )}

      <div className="brewing-library-tabs">
        <button
          type="button"
          className={section === "recipes" ? "active" : ""}
          onClick={() => setSection("recipes")}
        >
          ספריית מתכונים
        </button>
        <button
          type="button"
          className={section === "ingredients" ? "active" : ""}
          onClick={() => setSection("ingredients")}
        >
          ספריית חומרי גלם
        </button>
      </div>

      {message && <div className="brewing-message">{message}</div>}

      {section === "recipes" && (
        <>
          <div className="brewing-panel-heading">
            <div>
              <h2>ספריית מתכונים</h2>
              <p>כל כרטיס הוא מתכון. נכנסים לעריכה רק כשצריך לשנות אותו.</p>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowNewRecipe((value) => !value)}
            >
              + מתכון חדש
            </button>
          </div>

          {showNewRecipe && (
            <div className="brew-library-create-row">
              <input
                placeholder="שם המתכון / סגנון"
                value={newRecipeName}
                onChange={(e) => setNewRecipeName(e.target.value)}
              />
              <button type="button" className="btn-primary" onClick={createRecipe}>
                צור
              </button>
              <button type="button" onClick={() => setShowNewRecipe(false)}>
                ביטול
              </button>
            </div>
          )}

          <div className="brew-library-grid">
            {recipes.map((recipe) => (
              <article className="brew-library-card" key={recipe.id}>
                <button
                  type="button"
                  className="brew-library-card-main"
                  onClick={() => {
                    setDeleteRecipeId(null);
                    setSelectedRecipeId(recipe.id);
                  }}
                >
                  <div>
                    <strong>{recipe.style}</strong>
                    <span>גרסה {recipe.version}</span>
                  </div>
                  <small>
                    {recipe.grains.length} סוגי לתת · {recipe.hops.length} תוספות כשות
                  </small>
                  <small>
                    {recipe.allowedTankTypes
                      .map((type) =>
                        type === "single"
                          ? "בודד"
                          : type === "double"
                            ? "כפול"
                            : "משולש",
                      )
                      .join(" · ")}
                  </small>
                </button>
                <div className="brew-library-card-actions">
                  {deleteRecipeId === recipe.id ? (
                    <>
                      <button
                        type="button"
                        className="brew-delete-confirm"
                        onClick={() => removeRecipe(recipe)}
                      >
                        אישור מחיקה
                      </button>
                      <button
                        type="button"
                        className="brew-icon-button"
                        onClick={() => setDeleteRecipeId(null)}
                      >
                        ביטול
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="brew-action-button brew-action-button-danger"
                      aria-label={`מחק ${recipe.style}`}
                      title="מחק מתכון"
                      onClick={() => removeRecipe(recipe)}
                    >
                      מחק
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {section === "ingredients" && (
        <>
          <div className="brewing-panel-heading">
            <div>
              <h2>ספריית חומרי גלם</h2>
              <p>
                כאן נשמר המידע המשתנה של החומר שנמצא עכשיו במבשלה: ספק, lot, aa ותוקף.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setShowNewIngredient((value) => !value)}
            >
              + חומר גלם
            </button>
          </div>

          {showNewIngredient && (
            <div className="brew-library-create-row">
              <input
                placeholder="שם חומר הגלם"
                value={newIngredientName}
                onChange={(e) => setNewIngredientName(e.target.value)}
              />
              <select
                value={newIngredientCategory}
                onChange={(e) =>
                  setNewIngredientCategory(e.target.value as IngredientCategory)
                }
              >
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <button type="button" className="btn-primary" onClick={createIngredient}>
                הוסף
              </button>
            </div>
          )}

          <div className="brew-ingredient-grid">
            {ingredients.map((ingredient) => {
              const lot = activeLot(ingredient);
              return (
                <article
                  className={`brew-ingredient-card brew-ingredient-card-${ingredient.category}`}
                  key={ingredient.id}
                >
                  <div className="brew-ingredient-card-head">
                    <strong>{ingredient.name}</strong>
                    <span>{CATEGORY_LABELS[ingredient.category]}</span>
                  </div>

                  <label>
                    שם
                    <input
                      value={ingredient.name}
                      onChange={(e) =>
                        updateIngredient(ingredient.id, "name", e.target.value)
                      }
                    />
                  </label>

                  <label>
                    ספק נוכחי
                    <input
                      value={lot?.supplier || ""}
                      onChange={(e) =>
                        updateIngredient(ingredient.id, "supplier", e.target.value)
                      }
                    />
                  </label>

                  <label>
                    Lot / אצווה
                    <input
                      value={lot?.lotNumber || ""}
                      onChange={(e) =>
                        updateIngredient(ingredient.id, "lotNumber", e.target.value)
                      }
                    />
                  </label>

                  {ingredient.category === "hop" && (
                    <label>
                      aa נוכחי %
                      <input
                        type="number"
                        step="0.1"
                        value={lot?.alpha ?? ""}
                        onChange={(e) =>
                          updateIngredient(ingredient.id, "alpha", e.target.value)
                        }
                      />
                    </label>
                  )}

                  {ingredient.category === "yeast" && (
                    <label>
                      BBE
                      <input
                        value={lot?.bbe || ""}
                        onChange={(e) =>
                          updateIngredient(ingredient.id, "bbe", e.target.value)
                        }
                      />
                    </label>
                  )}

                  <button
                    type="button"
                    className="brew-action-button brew-manage-lots-button"
                    onClick={() => {
                      setDeleteLotKey(null);
                      setLotsIngredientId(ingredient.id);
                    }}
                  >
                    ניהול אצוות ({ingredient.lots.length})
                  </button>
                </article>
              );
            })}
          </div>

          <div className="brew-library-autosave-note">
            השינויים בספריית חומרי הגלם נשמרים אוטומטית.
          </div>

          <IngredientLotsModal
            ingredient={
              ingredients.find((item) => item.id === lotsIngredientId) || null
            }
            deleteLotKey={deleteLotKey}
            onClose={() => {
              setDeleteLotKey(null);
              setLotsIngredientId(null);
            }}
            onUpdateLot={updateIngredientLot}
            onSetStatus={setIngredientLotStatus}
            onAddLot={addIngredientLot}
            onDeleteLot={deleteIngredientLot}
          />
        </>
      )}
    </section>
  );
}
