import { useEffect, useState } from "react";
import { deletePallet, splitPallet, updatePallet } from "../SERVICES/Palletservice";
import { MAX_CRATES_PER_PALLET, MAX_KEGS_PER_PALLET } from "../SERVICES/Pallettypes ";
import type { Pallet, PalletItemType } from "../SERVICES/Pallettypes ";
import ConfirmModal from "./ConfirmModal";

function itemLabel(type: PalletItemType) { return type === "kegs" ? "חביות" : "ארגזים"; }

export default function PalletEditModal({ pallet, onClose, onDone }: { pallet: Pallet; onClose: () => void; onDone: () => void }) {
    const [itemType, setItemType] = useState<PalletItemType>(pallet.itemType);
    const [beerStyle, setBeerStyle] = useState(pallet.beerStyle);
    const [subLabel, setSubLabel] = useState(pallet.subLabel ?? "");
    const [quantity, setQuantity] = useState(pallet.quantity);
    const [expiryDateStr, setExpiryDateStr] = useState(pallet.expiryDateStr ?? "");
    const [batchNumber, setBatchNumber] = useState(pallet.batchNumber ?? "");
    const [splitQty, setSplitQty] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmSensitive, setConfirmSensitive] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        setItemType(pallet.itemType); setBeerStyle(pallet.beerStyle); setSubLabel(pallet.subLabel ?? "");
        setQuantity(pallet.quantity); setExpiryDateStr(pallet.expiryDateStr ?? ""); setBatchNumber(pallet.batchNumber ?? "");
    }, [pallet]);

    const sensitiveChanged = itemType !== pallet.itemType || beerStyle.trim() !== pallet.beerStyle ||
        subLabel.trim() !== (pallet.subLabel ?? "") || expiryDateStr.trim() !== (pallet.expiryDateStr ?? "") ||
        batchNumber.trim() !== (pallet.batchNumber ?? "");

    async function save() {
        if (sensitiveChanged && !confirmSensitive) { setConfirmSensitive(true); return; }
        setBusy(true); setError(null);
        try {
            await updatePallet(pallet.id, { itemType, beerStyle, subLabel, quantity, expiryDateStr, batchNumber });
            onDone();
        } catch (e: any) { setError(e?.message ?? "שגיאה בשמירת המשטח"); }
        finally { setBusy(false); }
    }

    async function split() {
        setBusy(true); setError(null);
        try { await splitPallet(pallet.id, splitQty, null); onDone(); }
        catch (e: any) { setError(e?.message ?? "שגיאה בפיצול"); }
        finally { setBusy(false); }
    }

    async function remove() {
        setBusy(true); setError(null);
        try { await deletePallet(pallet.id); onDone(); }
        catch (e: any) { setError(e?.message ?? "שגיאה במחיקת המשטח"); }
        finally { setBusy(false); setConfirmDelete(false); }
    }

    const max = itemType === "kegs" ? MAX_KEGS_PER_PALLET : MAX_CRATES_PER_PALLET;

    return (<>

        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-box pallet-edit-modal" onClick={(e) => e.stopPropagation()} dir="rtl">
                <div className="modal-header-row">
                    <div><h3>{pallet.beerStyle}{pallet.subLabel ? ` · ${pallet.subLabel}` : ""}</h3></div>
                    <button className="modal-x" onClick={onClose}>×</button>
                </div>

                <div className="edit-warning-box"><span>שים לב:</span> שינוי סגנון, אצווה או תאריך תפוגה משנה מידע תפעולי.</div>

                <label>סוג פריט</label>
                <select value={itemType} onChange={(e) => setItemType(e.target.value as PalletItemType)}>
                    <option value="crates">ארגזים</option><option value="kegs">חביות</option>
                </select>

                <label>סגנון בירה</label><input value={beerStyle} onChange={(e) => setBeerStyle(e.target.value)} />
                <label>תווית משנה</label><input value={subLabel} onChange={(e) => setSubLabel(e.target.value)} placeholder="לא חובה" />
                <label>מספר אצווה</label><input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder="לא חובה" />
                <label>כמות ({itemLabel(itemType)}, עד {max})</label><input type="number" min={1} max={max} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
                <label>תאריך תפוגה</label><input value={expiryDateStr} onChange={(e) => setExpiryDateStr(e.target.value)} placeholder="DD/MM/YYYY" />

                {confirmSensitive && (
                    <div className="edit-confirm-box">
                        <span>השינוי כולל נתון תפעולי.</span>
                        <span>לחץ על שמירה כדי לאשר את השינוי.</span>
                    </div>
                )}
                {error && <div className="edit-specs-message error">{error}</div>}

                <div className="modal-actions-primary">
                    <button className="modal-save-btn" disabled={busy} onClick={save}>{confirmSensitive ? "אישור ושמירה" : "שמור שינויים"}</button>
                    <button className="modal-cancel-btn" disabled={busy} onClick={onClose}>ביטול</button>
                </div>

                <div className="modal-section-divider" />
                <div className="split-section">
                    <div><span>פיצול משטח</span><small>הכמות שתיבחר- תופחת ממשטח זה ותועבר למשטח חדש עם פרטים זהים (מלבד הכמות). יש לשבץ את המשטח החדש מלשונית "ממתינים לשיבוץ"</small></div>
                    <div className="split-controls"><input type="number" min={1} max={Math.max(1, quantity - 1)} value={splitQty} onChange={(e) => setSplitQty(Number(e.target.value))} /><button disabled={busy || splitQty <= 0 || splitQty >= quantity} onClick={split}>פצל</button></div>
                </div>
                <div  className="danger-zone">
                <button disabled={busy} onClick={() => setConfirmDelete(true)}>מחק משטח</button>

                </div>
            </div>
        </div>
        {confirmDelete && (
            <ConfirmModal
                title="מחיקת משטח"
                message="למחוק את המשטח לצמיתות? הפעולה אינה ניתנת לביטול."
                confirmLabel="מחקי"
                danger
                onConfirm={remove}
                onCancel={() => setConfirmDelete(false)}
            />
        )}
    </>
    );
}
