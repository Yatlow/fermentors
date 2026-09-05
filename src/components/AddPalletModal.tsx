import { useEffect, useMemo, useState } from "react";
import { createPallets } from "../SERVICES/Palletservice";
import { MAX_CRATES_PER_PALLET, MAX_KEGS_PER_PALLET, } from "../SERVICES/Pallettypes ";
import { getDefaultExpiryDateStr } from "../SERVICES/packagingMasterSheetLogger";
import type { Fermentor } from "../App";
import { ArrowLeft } from "lucide-react";

type CreateMode = "total" | "same";


export default function AddPalletModal({ brews, onClose, onDone }: { brews?: Fermentor[]; onClose: () => void; onDone: () => void }) {
    const [itemType, setItemType] = useState<"kegs" | "crates">("crates");
    const [beerStyle, setBeerStyle] = useState("");
    const [subLabel, setSubLabel] = useState("");
    const [quantity, setQuantity] = useState(84);
    const [palletCount, setPalletCount] = useState(5);
    const [createMode, setCreateMode] = useState<CreateMode>("total");
    const [expiryDateStr, setExpiryDateStr] = useState("");
    const [expiryLoading, setExpiryLoading] = useState(false);
    const [batchNumber, setBatchNumber] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const maxPerPallet = itemType === "kegs" ? MAX_KEGS_PER_PALLET : MAX_CRATES_PER_PALLET;
    const knownBatches = useMemo(() => {
        if (!brews) return [];
        const seen = new Map<string, { batchNumber: string; beerStyle: string }>();
        brews.forEach((b) => { if (b.batchNumber != null && b.beerStyle) seen.set(String(b.batchNumber), { batchNumber: String(b.batchNumber), beerStyle: b.beerStyle }); });
        return Array.from(seen.values());
    }, [brews]);

    useEffect(() => { setQuantity(itemType === "kegs" ? 20 : 84); }, [itemType]);

    useEffect(() => {
        let cancelled = false;
        if (!beerStyle.trim()) { setExpiryDateStr(""); return; }
        setExpiryLoading(true);
        getDefaultExpiryDateStr(itemType === "kegs" ? "kegs" : "bottles", beerStyle)
            .then((date) => { if (!cancelled && date) setExpiryDateStr(date); })
            .catch(() => { if (!cancelled) setExpiryDateStr(""); })
            .finally(() => { if (!cancelled) setExpiryLoading(false); });
        return () => { cancelled = true; };
    }, [itemType, beerStyle]);

    function pickBatch(bn: string) {
        setBatchNumber(bn);
        const match = knownBatches.find((b) => b.batchNumber === bn);
        if (match) setBeerStyle(match.beerStyle);
    }

    async function submit() {
        if (!beerStyle.trim()) { setError("יש להזין סגנון בירה"); return; }
        if (quantity <= 0) { setError("כמות חייבת להיות גדולה מ-0"); return; }
        if (createMode === "same" && quantity > maxPerPallet) { setError(`למשטח בודד אפשר להכניס עד ${maxPerPallet} ${itemType === "kegs" ? "חביות" : "ארגזים"}`); return; }
        if (createMode === "same" && palletCount < 1) { setError("מספר המשטחים חייב להיות לפחות 1"); return; }

        setBusy(true); setError(null);
        try {
            await createPallets({ itemType, beerStyle: beerStyle.trim(), subLabel: subLabel.trim() || null, quantity, palletCount: createMode === "same" ? Math.floor(palletCount) : undefined, expiryDateStr: expiryDateStr || null, batchNumber: batchNumber.trim() || null });
            onDone();
        } catch (e: any) { setError(e?.message ?? "שגיאה בהוספת המשטחים"); }
        finally { setBusy(false); }
    }

    const totalPreview = createMode === "same" ? quantity * Math.floor(palletCount) : quantity;
    const palletPreview = createMode === "same" ? Math.floor(palletCount) : Math.ceil(quantity / maxPerPallet);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box pallet-add-modal" onClick={(e) => e.stopPropagation()} dir="rtl">
                <div className="modal-header-row"><div><span className="modal-kicker">מלאי חדש</span><h3>הוספת משטחים</h3></div><button className="modal-x" onClick={onClose}>×</button></div>
                <p className="modal-hint">המשטחים ייווצרו ב״ממתינים לשיבוץ״.</p>

                <label>סוג</label>
                <select value={itemType} onChange={(e) => setItemType(e.target.value as "kegs" | "crates")}><option value="crates">ארגזים</option><option value="kegs">חביות</option></select>

                {knownBatches.length > 0 && <><label>ייבוא נתונים מאצווה קיימת</label><select value={batchNumber} onChange={(e) => pickBatch(e.target.value)}><option value="">— הזנה ידנית —</option>{knownBatches.map((b) => <option key={b.batchNumber} value={b.batchNumber}>{b.batchNumber} · {b.beerStyle}</option>)}</select></>}

                <label>סגנון בירה</label><input value={beerStyle} onChange={(e) => setBeerStyle(e.target.value)} placeholder="למשל IPA, פייל, לאגר" />
                <label>תווית משנה</label><input value={subLabel} onChange={(e) => setSubLabel(e.target.value)} placeholder="לא חובה" />
                <label>מספר אצווה</label><input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder="לא חובה" />

                <div className="create-mode-toggle"><button className={createMode === "total" ? "active" : ""} onClick={() => setCreateMode("total")}>כמות כוללת</button><button className={createMode === "same" ? "active" : ""} onClick={() => setCreateMode("same")}>כמה משטחים זהים</button></div>

                {createMode === "total" ? (
                    <><label>כמות כוללת ({itemType === "kegs" ? "חביות" : "ארגזים"})</label><input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
                        {itemType === "kegs" ?
                            <small className="field-hint">לדוגמה: 130 חביות {<ArrowLeft size={12} />} 6 משטחים של 20 + משטח אחד של 10.</small> :
                            <small className="field-hint">לדוגמה: 144 ארגזים {<ArrowLeft size={12} />}  משטח אחד של 84 + משטח אחד של 60.</small>
                        }
                    </>
                ) : (
                    <div className="same-pallet-grid"><div><label>כמות בכל משטח</label><input type="number" min={1} max={maxPerPallet} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></div><div><label>מספר משטחים</label><input type="number" min={1} value={palletCount} onChange={(e) => setPalletCount(Number(e.target.value))} /></div></div>
                )}

                <label>תאריך תפוגה <span className="auto-label">מחושב אוטומטית</span></label>
                <input value={expiryDateStr} onChange={(e) => setExpiryDateStr(e.target.value)} placeholder={expiryLoading ? "מחשב…" : "DD/MM/YYYY"} />
                <small className="field-hint">מבוסס על אותה טבלת תוקף שמשמשת את דיווח האריזה. אפשר לשנות ידנית.</small>

                <div className="add-preview"><strong>{palletPreview} משטחים</strong><span>סה״כ {totalPreview} {itemType === "kegs" ? "חביות" : "ארגזים"}</span></div>
                {error && <div className="edit-specs-message error">{error}</div>}
                <button className="modal-save-btn" disabled={busy || expiryLoading} onClick={submit}>{busy ? "יוצר…" : "הוסף משטחים"}</button>
                <button className="modal-cancel-btn" disabled={busy} onClick={onClose}>ביטול</button>
            </div>
        </div>
    );
}
