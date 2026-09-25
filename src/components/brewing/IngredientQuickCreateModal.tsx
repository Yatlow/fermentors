import { useEffect, useState } from "react";
import type { IngredientCategory } from "../../SERVICES/brewing/ingredientLibrary";
import type { CreateIngredientInput } from "../../SERVICES/brewing/ingredientEditorStore";

type Props = {
  open: boolean;
  category: IngredientCategory;
  onClose: () => void;
  onCreate: (input: CreateIngredientInput) => void;
};

const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  grain: "לתת",
  hop: "כשות",
  yeast: "שמרים",
  other: "חומר גלם",
};

export default function IngredientQuickCreateModal({
  open,
  category,
  onClose,
  onCreate,
}: Props) {
  const [name, setName] = useState("");
  const [supplier, setSupplier] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [alpha, setAlpha] = useState("");
  const [bbe, setBbe] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setSupplier("");
    setLotNumber("");
    setAlpha("");
    setBbe("");
  }, [open, category]);

  if (!open) return null;

  const canCreate = name.trim().length > 0;

  return (
    <div
      className="brew-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="brew-create-modal brew-ingredient-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ingredient-create-title"
      >
        <div className="brew-modal-header">
          <div>
            <h2 id="ingredient-create-title">
              יצירת {CATEGORY_LABELS[category]} חדש
            </h2>
            <p>
              החומר יתווסף מיד לספריית חומרי הגלם וגם ייבחר במתכון.
            </p>
          </div>
          <button
            type="button"
            className="brew-modal-close"
            onClick={onClose}
            aria-label="סגירה"
          >
            ×
          </button>
        </div>

        <div className="brew-modal-fields">
          <label>
            שם
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label>
            ספק
            <input
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
            />
          </label>

          <label>
            Lot / אצווה
            <input
              value={lotNumber}
              onChange={(event) => setLotNumber(event.target.value)}
            />
          </label>

          {category === "hop" && (
            <label>
              aa נוכחי %
              <input
                type="number"
                step="0.1"
                value={alpha}
                onChange={(event) => setAlpha(event.target.value)}
              />
            </label>
          )}

          {category === "yeast" && (
            <label>
              BBE
              <input
                value={bbe}
                onChange={(event) => setBbe(event.target.value)}
              />
            </label>
          )}
        </div>

        <div className="brew-modal-actions">
          <button type="button" onClick={onClose}>
            ביטול
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!canCreate}
            onClick={() =>
              onCreate({
                name: name.trim(),
                category,
                supplier: supplier.trim() || undefined,
                lotNumber: lotNumber.trim() || undefined,
                alpha:
                  category === "hop" && alpha !== ""
                    ? Number(alpha)
                    : undefined,
                bbe:
                  category === "yeast" && bbe.trim()
                    ? bbe.trim()
                    : undefined,
              })
            }
          >
            צור ובחר
          </button>
        </div>
      </section>
    </div>
  );
}
