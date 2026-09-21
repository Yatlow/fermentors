import { useMemo, useState } from "react";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
  createSandboxRecipe,
  deleteSandboxRecipe,
  loadSandboxRecipes,
  saveSandboxRecipe,
} from "../../SERVICES/brewing/sandboxRecipe";
import {
  activeLot,
  type IngredientCategory,
  type IngredientDefinition,
  type IngredientLotStatus,
} from "../../SERVICES/brewing/ingredientLibrary";
import {
  createSandboxIngredient,
  loadSandboxIngredients,
  saveSandboxIngredients,
  type CreateSandboxIngredientInput,
} from "../../SERVICES/brewing/sandboxIngredients";
import BrewRecipeEditor from "./BrewRecipeEditor";

type Props = {
  onRecipesChange?: (recipes: BrewRecipe[]) => void;
};

type LibrarySection = "recipes" | "ingredients";

const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  grain: "לתת",
  hop: "כשות",
  yeast: "שמרים",
  other: "אחר",
};

export default function BrewingLibrary({ onRecipesChange }: Props) {
  const [section, setSection] = useState<LibrarySection>("recipes");
  const [recipes, setRecipes] = useState<BrewRecipe[]>(() => loadSandboxRecipes());
  const [ingredients, setIngredients] = useState<IngredientDefinition[]>(() =>
    loadSandboxIngredients(),
  );
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

  const selectedRecipe = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedRecipeId) || null,
    [recipes, selectedRecipeId],
  );

  function saveRecipe(recipe: BrewRecipe) {
    const saved = saveSandboxRecipe(recipe);
    const next = loadSandboxRecipes();
    setRecipes(next);
    setSelectedRecipeId(null);
    onRecipesChange?.(next);
    setMessage(`${saved.style} נשמר כגרסה ${saved.version}.`);
  }

  function createRecipe() {
    const name = newRecipeName.trim();
    if (!name) return;
    const created = createSandboxRecipe(name);
    const next = loadSandboxRecipes();
    setRecipes(next);
    onRecipesChange?.(next);
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
    deleteSandboxRecipe(recipe.id);
    const next = loadSandboxRecipes();
    setRecipes(next);
    onRecipesChange?.(next);
    setDeleteRecipeId(null);
    setMessage(`${recipe.style} נמחק מספריית המתכונים. אצוות קיימות לא משתנות.`);
  }

  function updateIngredient(
    ingredientId: string,
    field: "name" | "supplier" | "lotNumber" | "alpha" | "bbe",
    value: string,
  ) {
    setIngredients((current) =>
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

  function persistIngredients() {
    const saved = saveSandboxIngredients(ingredients);
    setIngredients(saved);
    setMessage("ספריית חומרי הגלם נשמרה ב-Sandbox.");
  }

  function createIngredientFromInput(
    input: CreateSandboxIngredientInput,
  ): IngredientDefinition {
    const result = createSandboxIngredient(input, ingredients);
    setIngredients(result.ingredients);
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
    setIngredients((current) =>
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
    setIngredients((current) =>
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
    setIngredients((current) =>
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

    setIngredients((current) =>
      current.flatMap((ingredient) => {
        if (ingredient.id !== ingredientId) return [ingredient];

        const remainingLots = ingredient.lots.filter(
          (lot) => lot.id !== lotId,
        );

        if (remainingLots.length === 0) {
          return [];
        }

        const hasActive = remainingLots.some((lot) => lot.active);
        return [
          {
            ...ingredient,
            lots: hasActive
              ? remainingLots
              : remainingLots.map((lot, index) =>
                  index === 0
                    ? {
                        ...lot,
                        active: true,
                        status: "current" as const,
                      }
                    : lot,
                ),
          },
        ];
      }),
    );

    setDeleteLotKey(null);
    setMessage("");
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

                  <details className="brew-lot-history">
                    <summary>
                      אצוות חומר גלם ({ingredient.lots.length})
                    </summary>
                    <div className="brew-lot-list">
                      {ingredient.lots.map((item) => (
                        <div className="brew-lot-editor" key={item.id}>
                          <div className="brew-lot-editor-head">
                            <strong>
                              {item.lotNumber || "אצווה ללא מספר"}
                            </strong>
                            <div className="brew-lot-editor-head-actions">
                              <select
                                value={item.status || "unknown"}
                                onChange={(e) =>
                                  setIngredientLotStatus(
                                    ingredient.id,
                                    item.id,
                                    e.target.value as IngredientLotStatus,
                                  )
                                }
                              >
                                <option value="current">בשימוש</option>
                                <option value="next">ממתין לשימוש</option>
                                <option value="received">התקבל</option>
                                <option value="ended">נגמר</option>
                                <option value="unknown">ללא סטטוס</option>
                              </select>

                              <button
                                type="button"
                                className="brew-action-button brew-action-button-danger"
                                onClick={() =>
                                  deleteIngredientLot(
                                    ingredient.id,
                                    item.id,
                                  )
                                }
                              >
                                {deleteLotKey ===
                                `${ingredient.id}:${item.id}`
                                  ? ingredient.lots.length === 1
                                    ? "אישור מחיקת חומר"
                                    : "אישור מחיקת אצווה"
                                  : ingredient.lots.length === 1
                                    ? "מחק חומר גלם"
                                    : "מחק אצווה"}
                              </button>
                            </div>
                          </div>

                          <div className="brew-lot-editor-grid">
                            <label>
                              ספק
                              <input
                                value={item.supplier || ""}
                                onChange={(e) =>
                                  updateIngredientLot(
                                    ingredient.id,
                                    item.id,
                                    "supplier",
                                    e.target.value,
                                  )
                                }
                              />
                            </label>
                            <label>
                              Lot / אצווה
                              <input
                                value={item.lotNumber || ""}
                                onChange={(e) =>
                                  updateIngredientLot(
                                    ingredient.id,
                                    item.id,
                                    "lotNumber",
                                    e.target.value,
                                  )
                                }
                              />
                            </label>

                            {ingredient.category === "hop" && (
                              <label>
                                aa %
                                <input
                                  type="number"
                                  step="0.1"
                                  value={item.alpha ?? ""}
                                  onChange={(e) =>
                                    updateIngredientLot(
                                      ingredient.id,
                                      item.id,
                                      "alpha",
                                      e.target.value,
                                    )
                                  }
                                />
                              </label>
                            )}

                            {ingredient.category === "yeast" && (
                              <label>
                                BBE
                                <input
                                  value={item.bbe || ""}
                                  onChange={(e) =>
                                    updateIngredientLot(
                                      ingredient.id,
                                      item.id,
                                      "bbe",
                                      e.target.value,
                                    )
                                  }
                                />
                              </label>
                            )}

                            <label>
                              תאריך קבלה
                              <input
                                type="date"
                                value={item.receivedDate || ""}
                                onChange={(e) =>
                                  updateIngredientLot(
                                    ingredient.id,
                                    item.id,
                                    "receivedDate",
                                    e.target.value,
                                  )
                                }
                              />
                            </label>
                            <label>
                              התחלת שימוש
                              <input
                                type="date"
                                value={item.startedDate || ""}
                                onChange={(e) =>
                                  updateIngredientLot(
                                    ingredient.id,
                                    item.id,
                                    "startedDate",
                                    e.target.value,
                                  )
                                }
                              />
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      className="brew-action-button"
                      onClick={() => addIngredientLot(ingredient.id)}
                    >
                      + אצוות חומר גלם
                    </button>
                  </details>
                </article>
              );
            })}
          </div>

          <div className="brew-editor-actions">
            <button type="button" className="btn-primary" onClick={persistIngredients}>
              שמור חומרי גלם
            </button>
          </div>
        </>
      )}
    </section>
  );
}
