import { useMemo, useState } from "react";
import type { BrewRecipe } from "../../SERVICES/brewing/brewRecipe";
import {
  createSandboxRecipe,
  loadSandboxRecipes,
  saveSandboxRecipe,
} from "../../SERVICES/brewing/sandboxRecipe";
import {
  activeLot,
  type IngredientCategory,
  type IngredientDefinition,
} from "../../SERVICES/brewing/ingredientLibrary";
import {
  loadSandboxIngredients,
  saveSandboxIngredients,
} from "../../SERVICES/brewing/sandboxIngredients";
import BrewRecipeEditor from "./BrewRecipeEditor";

type Props = {
  onRecipeChange?: (recipe: BrewRecipe) => void;
};

type LibrarySection = "recipes" | "ingredients";

const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  grain: "לתת / גרעינים",
  hop: "כשות",
  yeast: "שמרים",
  other: "אחר",
};

function newIngredientId(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9א-ת_-]/g, "");
  return base || `ingredient-${Date.now()}`;
}

export default function BrewingLibrary({ onRecipeChange }: Props) {
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

  const selectedRecipe = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedRecipeId) || null,
    [recipes, selectedRecipeId],
  );

  function saveRecipe(recipe: BrewRecipe) {
    const saved = saveSandboxRecipe(recipe);
    const next = loadSandboxRecipes();
    setRecipes(next);
    setSelectedRecipeId(null);
    onRecipeChange?.(saved);
    setMessage(`${saved.style} נשמר כגרסה ${saved.version}.`);
  }

  function createRecipe() {
    const name = newRecipeName.trim();
    if (!name) return;
    const created = createSandboxRecipe(name);
    setRecipes(loadSandboxRecipes());
    setNewRecipeName("");
    setShowNewRecipe(false);
    setSelectedRecipeId(created.id);
    setMessage("");
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

        let activeIndex = lots.findIndex((lot) => lot.active);
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

  function createIngredient() {
    const name = newIngredientName.trim();
    if (!name) return;

    const baseId = newIngredientId(name);
    let id = baseId;
    if (ingredients.some((item) => item.id === id)) {
      id = `${baseId}-${Date.now()}`;
    }

    const next: IngredientDefinition = {
      id,
      name,
      category: newIngredientCategory,
      lots: [
        {
          id: `${id}-current`,
          lotNumber: "",
          active: true,
        },
      ],
    };

    const saved = saveSandboxIngredients([...ingredients, next]);
    setIngredients(saved);
    setNewIngredientName("");
    setShowNewIngredient(false);
    setMessage("חומר הגלם נוסף לספרייה.");
  }

  if (selectedRecipe) {
    return (
      <BrewRecipeEditor
        recipe={selectedRecipe}
        ingredients={ingredients}
        onSave={saveRecipe}
        onBack={() => setSelectedRecipeId(null)}
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
              <button
                type="button"
                className="brew-library-card"
                key={recipe.id}
                onClick={() => setSelectedRecipeId(recipe.id)}
              >
                <div>
                  <strong>{recipe.style}</strong>
                  <span>גרסה {recipe.version}</span>
                </div>
                <small>
                  {recipe.grains.length} חומרי מאש · {recipe.hops.length} תוספות כשות
                </small>
                <small>
                  {recipe.allowedTankTypes
                    .map((type) =>
                      type === "single" ? "בודד" : type === "double" ? "כפול" : "משולש",
                    )
                    .join(" · ")}
                </small>
              </button>
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
                כאן נשמר המידע המשתנה של החומר שנמצא עכשיו במבשלה: ספק, lot, AA ותוקף.
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
                <article className="brew-ingredient-card" key={ingredient.id}>
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
                      AA נוכחי %
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
