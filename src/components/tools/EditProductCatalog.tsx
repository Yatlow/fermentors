import { useEffect, useState } from "react";
import {
  getEditableCatalogEntries,
  type EditableCatalogEntry,
} from "../../SERVICES/cooler/PalletCatalog";
import { saveCatalogEntry, subscribeToProductCatalog } from "../../SERVICES/cooler/PalletCatalogFirestore";

export default function EditProductCatalog({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<EditableCatalogEntry[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const refresh = () => setRows(getEditableCatalogEntries().map((row) => ({ ...row })));

  useEffect(() => {
    refresh();
    return subscribeToProductCatalog(refresh);
  }, []);

  const patch = (id: string, change: Partial<EditableCatalogEntry>) =>
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...change } : row));

  const add = () => {
    const id = `new-${Date.now()}`;
    setRows((current) => [...current, {
      id,
      styleKey: "",
      beerStyle: "",
      itemType: "crates",
      sku: "",
      displayText: "",
      enabled: true,
    }]);
  };

  const save = async (row: EditableCatalogEntry) => {
    if (!isAdmin) return;
    setSaving(row.id);
    setMessage("");
    try {
      await saveCatalogEntry({
        styleKey: row.styleKey,
        beerStyle: row.beerStyle,
        itemType: row.itemType,
        sku: row.sku,
        displayText: row.displayText,
        enabled: row.enabled,
      });
      setMessage("הקטלוג נשמר");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "שמירת הקטלוג נכשלה");
    } finally {
      setSaving(null);
    }
  };

  if (!isAdmin) return null;

  return (
    <section className="catalog-editor" dir="rtl">
      <div className="catalog-editor-header">
        <div>
          <h2>ניהול קטלוג מוצר מוגמר</h2>
          <p>המק״ט והתיאור משמשים בדפי אריזה ובמסמכי משלוח. שינויים נשמרים ב-Firestore וזמינים לכל המשתמשים.</p>
        </div>
        <button type="button" className="status-filter-button" onClick={add}>+ מוצר</button>
      </div>
      {message && <div className="catalog-editor-message">{message}</div>}
      <div className="catalog-editor-list">
        {rows.map((row) => (
          <article className="catalog-editor-row" key={row.id}>
            <label>סגנון
              <input value={row.beerStyle} onChange={(e) => patch(row.id, { beerStyle: e.target.value, styleKey: row.id.startsWith("new-") ? "" : row.styleKey })} />
            </label>
            <label>אריזה
              <select value={row.itemType} onChange={(e) => patch(row.id, { itemType: e.target.value as "crates" | "kegs" })}>
                <option value="crates">ארגזים</option>
                <option value="kegs">חביות</option>
              </select>
            </label>
            <label>מק״ט
              <input inputMode="numeric" value={row.sku} onChange={(e) => patch(row.id, { sku: e.target.value })} />
            </label>
            <label className="catalog-description">תיאור מוצר
              <input value={row.displayText} onChange={(e) => patch(row.id, { displayText: e.target.value })} />
            </label>
            <label className="catalog-enabled">
              <input type="checkbox" checked={row.enabled} onChange={(e) => patch(row.id, { enabled: e.target.checked })} />
              פעיל
            </label>
            <button type="button" className="status-filter-button active" disabled={saving === row.id} onClick={() => save(row)}>
              {saving === row.id ? "שומר…" : "שמור"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
