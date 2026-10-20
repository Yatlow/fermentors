import { useState } from "react";
import type { BrewPrintTextReplacement } from "../../SERVICES/brewing/brewingSheetServer";
import type { BrewRun } from "../../SERVICES/brewing/brewRun";

type Props = {
    run: BrewRun;
    onClose: () => void;
    onPrint: (run: BrewRun, changes: BrewPrintTextReplacement[]) => void;
};

export default function BrewPrintTextEditor({ run, onClose, onPrint }: Props) {
    const [rows, setRows] = useState<BrewPrintTextReplacement[]>([{ from: "", to: "" }]);
    const changes = rows
        .map((row) => ({ from: row.from.trim(), to: row.to }))
        .filter((row) => row.from.length > 0);
    const update = (index: number, field: "from" | "to", value: string) => {
        setRows((current) => current.map((item, i) => i === index ? { ...item, [field]: value } : item));
    };

    return (
        <div className="brew-modal-backdrop" dir="rtl">
            <form className="brew-create-modal brew-print-edit-modal" role="dialog"
                aria-modal="true" aria-label="עריכת טקסט להדפסה"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!changes.length) return;
                    onPrint(run, changes);
                    onClose();
                }}>
                <div className="brew-modal-header">
                    <div>
                        <h2>עריכת טקסט להדפסה · אצווה {run.batchNumber}</h2>
                        <p>כתוב את הטקסט הקיים ואת הטקסט שיופיע במקומו.
                            השינוי יחול על ה־PDF בלבד ולא יעדכן את ה־Sheet המקורי.</p>
                    </div>
                    <button type="button" className="brew-modal-close" onClick={onClose} aria-label="סגור">×</button>
                </div>
                <div className="brew-modal-fields">
                    {rows.map((row, index) => (
                        <div className="brew-print-edit-row" key={index}>
                            <label>טקסט קיים
                                <input value={row.from} maxLength={120} placeholder="לדוגמה: הוצאה לבישול"
                                    onChange={(event) => update(index, "from", event.target.value)} />
                            </label>
                            <label>טקסט חדש
                                <input value={row.to} maxLength={200} placeholder="השאר ריק למחיקה"
                                    onChange={(event) => update(index, "to", event.target.value)} />
                            </label>
                            {rows.length > 1 && (
                                <button type="button" className="brew-print-edit-remove"
                                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                                    aria-label={`הסר החלפה ${index + 1}`}>×</button>
                            )}
                        </div>
                    ))}
                    {rows.length < 12 && (
                        <button type="button" className="brew-print-edit-add"
                            onClick={() => setRows((current) => [...current, { from: "", to: "" }])}>
                            + הוסף החלפת טקסט
                        </button>
                    )}
                </div>
                <div className="brew-modal-actions">
                    <button type="button" onClick={onClose}>ביטול</button>
                    <button type="submit" className="btn-primary" disabled={!changes.length}>הדפס עם השינויים</button>
                </div>
            </form>
        </div>
    );
}
