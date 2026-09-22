import type {
  IngredientDefinition,
  IngredientLotStatus,
} from "../../SERVICES/brewing/ingredientLibrary";

type EditableLotField =
  | "supplier"
  | "lotNumber"
  | "alpha"
  | "bbe"
  | "receivedDate"
  | "startedDate";

type Props = {
  ingredient: IngredientDefinition | null;
  deleteLotKey: string | null;
  onClose: () => void;
  onUpdateLot: (
    ingredientId: string,
    lotId: string,
    field: EditableLotField,
    value: string,
  ) => void;
  onSetStatus: (
    ingredientId: string,
    lotId: string,
    status: IngredientLotStatus,
  ) => void;
  onAddLot: (ingredientId: string) => void;
  onDeleteLot: (ingredientId: string, lotId: string) => void;
};

export default function IngredientLotsModal({
  ingredient,
  deleteLotKey,
  onClose,
  onUpdateLot,
  onSetStatus,
  onAddLot,
  onDeleteLot,
}: Props) {
  if (!ingredient) return null;

  return (
    <div
      className="brew-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="brew-create-modal brew-lots-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brew-lots-title"
      >
        <div className="brew-modal-header">
          <div>
            <h2 id="brew-lots-title">
              אצוות חומר גלם · {ingredient.name}
            </h2>
            <p>
              כאן מנהלים היסטוריה, אצווה בשימוש ואצוות שממתינות לשימוש.
            </p>
          </div>
          <button
            type="button"
            className="brew-modal-close brew-button-icon"
            onClick={onClose}
            aria-label="סגירה"
          >
            ×
          </button>
        </div>

        <div className="brew-lots-modal-list">
          {ingredient.lots.map((item) => {
            const key = `${ingredient.id}:${item.id}`;
            return (
              <article
                className="brew-lot-editor"
                key={item.id}
              >
                <div className="brew-lot-editor-head">
                  <strong>
                    {item.lotNumber || "אצווה ללא מספר"}
                  </strong>

                  <div className="brew-lot-editor-head-actions">
                    <select
                      value={item.status || "unknown"}
                      onChange={(event) =>
                        onSetStatus(
                          ingredient.id,
                          item.id,
                          event.target.value as IngredientLotStatus,
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
                        onDeleteLot(ingredient.id, item.id)
                      }
                    >
                      {deleteLotKey === key
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
                      onChange={(event) =>
                        onUpdateLot(
                          ingredient.id,
                          item.id,
                          "supplier",
                          event.target.value,
                        )
                      }
                    />
                  </label>

                  <label>
                    Lot / אצווה
                    <input
                      value={item.lotNumber || ""}
                      onChange={(event) =>
                        onUpdateLot(
                          ingredient.id,
                          item.id,
                          "lotNumber",
                          event.target.value,
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
                        onChange={(event) =>
                          onUpdateLot(
                            ingredient.id,
                            item.id,
                            "alpha",
                            event.target.value,
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
                        onChange={(event) =>
                          onUpdateLot(
                            ingredient.id,
                            item.id,
                            "bbe",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                  )}

                  <label className="brew-lot-date-field">
                    תאריך קבלה
                    <input
                      type="date"
                      value={item.receivedDate || ""}
                      onChange={(event) =>
                        onUpdateLot(
                          ingredient.id,
                          item.id,
                          "receivedDate",
                          event.target.value,
                        )
                      }
                    />
                  </label>

                  <label className="brew-lot-date-field">
                    התחלת שימוש
                    <input
                      type="date"
                      value={item.startedDate || ""}
                      onChange={(event) =>
                        onUpdateLot(
                          ingredient.id,
                          item.id,
                          "startedDate",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </div>
              </article>
            );
          })}
        </div>

        <div className="brew-modal-actions">
          <button
            type="button"
            className="brew-button-secondary"
            onClick={onClose}
          >
            סגור
          </button>
          <button
            type="button"
            className="btn-primary brew-button-primary"
            onClick={() => onAddLot(ingredient.id)}
          >
            + אצוות חומר גלם
          </button>
        </div>
      </section>
    </div>
  );
}
