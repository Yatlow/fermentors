import { useEffect, useState } from "react";
import type { Fermentor } from "../App";

export type NoteToFermentorProps = {
    brews: Fermentor[];
    updateReading: Function;
    onValidityChange?: (hasIncompleteRow: boolean) => void;
};

type NoteRow = {
    id: number;
    tankNumber: number | "";
    noteType: string;
    value: string;
    value2: string;
    direction: string;
};

const NOTE_TYPES = [
    { value: "גיזוז", label: "בדיקת גיזוז", stage: "cold" },
    { value: "שמרים", label: "הורדת שמרים", stage: "both" },
    { value: "לחץ", label: "שינוי לחץ", stage: "both" },
    { value: "פורק", label: "כיוון פורק", stage: "warm" },
    { value: "דיאציטיל", label: "מנוחת דיאציטיל", stage: "warm" },
    { value: "קירור", label: "קירור", stage: "warm" },
    { value: "אחר", label: "אחר", stage: "both" },
];

let rowIdCounter = 0;
function makeEmptyRow(): NoteRow {
    return { id: rowIdCounter++, tankNumber: "", noteType: "", value: "", value2: "", direction: "" };
}

const EMPTY_VALUES = { value: "", value2: "", direction: "" };

export default function NoteToFermentor({
    brews,
    updateReading,
    onValidityChange,
}: NoteToFermentorProps) {

    const [rows, setRows] = useState<NoteRow[]>([makeEmptyRow()]);

    const availableTanks = brews.filter(
        (fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1
    );

    function normelizeInputValue(value: string, max: number, min: number) {
        if (value === "") return "";
        const num = Number(value);
        if (num > max || num < min) return "";
        return value;
    }

    function updateRow(rowId: number, patch: Partial<NoteRow>) {
        setRows((prev) =>
            prev.map((row) => (row.id === rowId ? { ...row, ...patch } : row))
        );
    }

    function addRow() {
        setRows((prev) => [...prev, makeEmptyRow()]);
    }

    function removeRow(rowId: number) {
        setRows((prev) =>
            prev.length === 1 ? prev : prev.filter((row) => row.id !== rowId)
        );
    }

    function buildNoteText(row: NoteRow): string | null {
        switch (row.noteType) {
            case "גיזוז":
                if (row.value === "") return null;
                return `בדיקת גיזוז: ${row.value}`;
            case "שמרים":
                if (row.value === "" || row.value2 === "") return null;
                return `הורדת ${row.value} דליי שמרים, לחץ אחרי ${row.value2} bar`;
            case "לחץ":
                if (row.direction === "" || row.value === "") return null;
                return `${row.direction} לחץ ל: ${row.value} bar`;
            case "פורק":
                if (row.value === "") return null;
                return `כיוון פורק ל: ${row.value} bar`;
            case "דיאציטיל":
                return "חימום מיכל ל14° למנוחת דיאציטיל";
            case "קירור":
                return "קירור מיכל ל0.3°";
            case "אחר":
                if (row.value === "") return null;
                return row.value;
            default:
                return null;
        }
    }

    // שורה נחשבת "חלקית"/חוסמת שליחה רק אם כבר נבחר לה מיכל אך אין לה עדיין טקסט תקין
    function isRowIncomplete(row: NoteRow): boolean {
        if (!row.tankNumber) return false;
        return buildNoteText(row) === null;
    }

    // ===== הלב של התיקון =====
    // בכל שינוי ב-rows: מקבצים לפי מיכל, מחברים את כל ההערות התקינות של אותו מיכל
    // למחרוזת אחת, וכותבים את זה (או מנקים אם אין) לכל מיכל זמין.
    useEffect(() => {
        const notesByTank = new Map<number, string[]>();
        const carbonationByTank = new Map<number, string>();

        rows.forEach((row) => {
            if (!row.tankNumber) return;
            const noteText = buildNoteText(row);
            if (noteText === null) return;

            const tankNum = Number(row.tankNumber);
            if (row.noteType === "גיזוז") {
                carbonationByTank.set(tankNum, row.value);
            } else {
                if (!notesByTank.has(tankNum)) notesByTank.set(tankNum, []);
                notesByTank.get(tankNum)!.push(noteText);
            }
        });

        availableTanks.forEach((fv) => {
            const tankNum = Number(fv.tankNumber);
            const combinedNotes = notesByTank.get(tankNum);
            updateReading(
                fv.id,
                "notes",
                combinedNotes && combinedNotes.length ? combinedNotes.join(" | ") : undefined
            );

            const carbonationValue = carbonationByTank.get(tankNum);
            updateReading(
                fv.id,
                "carbonation",
                carbonationValue !== undefined ? carbonationValue : undefined
            );

        });

        onValidityChange?.(rows.some(isRowIncomplete));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows]);

    function handleNoteTypeChange(row: NoteRow, newType: string) {
        updateRow(row.id, { noteType: newType, ...EMPTY_VALUES });
    }

    function handleTankChange(row: NoteRow, newTank: number) {
        updateRow(row.id, { tankNumber: newTank, noteType: "", ...EMPTY_VALUES });
    }

    return (
        <div className="note-RowsBox">
            {rows.map((row) => {
                const fermentor = brews.find(
                    (fv) => Number(fv.tankNumber) === Number(row.tankNumber)
                );
                const stage = (Number(fermentor?.currentData?.temp) > 9 && fermentor?.stage?.name==="בתסיסה") ? "warm" : "cold";

                return (
                    <div className={`write-note-row note-${!fermentor ? "" : stage}`} key={row.id}>
                        <span>מספר אצווה</span>

                        <select
                            className="select-batch"
                            value={fermentor?.batchNumber ?? ""}
                            onChange={(e) => {
                                const selectedBatch = e.target.value;
                                const selected = availableTanks.find(
                                    (fv) => String(fv.batchNumber) === selectedBatch
                                );
                                if (selected) {
                                    handleTankChange(row, Number(selected.tankNumber));
                                }
                            }}
                        >
                            <option value="" disabled>בחר מספר אצווה</option>
                            {availableTanks.map((fv) => (
                                <option key={fv.id} value={fv.batchNumber ?? ""}>
                                    {fv.batchNumber}
                                </option>
                            ))}
                        </select>

                        <select
                            className="select-tank"
                            value={row.tankNumber || ""}
                            onChange={(e) => handleTankChange(row, Number(e.target.value))}
                        >
                            <option value="" disabled>בחר מיכל</option>
                            {availableTanks.map((fv) => (
                                <option key={fv?.id} value={fv?.tankNumber ?? ""}>
                                    מיכל {fv.tankNumber}
                                </option>
                            ))}
                        </select>
                        {fermentor && <span className="note-style">{fermentor.beerStyle}</span>}

                        {row.tankNumber && (
                            <select
                                className="select-notetype"
                                value={row.noteType || "בחר סוג דיווח"}
                                onChange={(e) => handleNoteTypeChange(row, e.target.value)}
                            >
                                <option value={"בחר סוג דיווח"} disabled>בחר סוג דיווח</option>
                                {NOTE_TYPES
                                    .filter((t) => t.stage === "both" || t.stage === stage)
                                    .map((t) => (
                                        <option key={t.value} value={t.value}>{t.label}</option>
                                    ))}
                            </select>
                        )}

                        <div className="note-value-slot">
                            {row.noteType === "אחר" && (
                                <input
                                    type="text"
                                    className="shortTxtInput"
                                    value={row.value}
                                    placeholder="כתוב הערה"
                                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                />
                            )}

                            {row.noteType === "גיזוז" && (
                                <>
                                    <span>גיזוז:  </span>
                                    <input
                                        min={0}
                                        max={15}
                                        type="number"
                                        value={row.value}
                                        placeholder="גיזוז"
                                        onChange={(e) => {
                                            const val = normelizeInputValue(e.target.value, 15, 0);
                                            updateRow(row.id, { value: val });
                                        }}
                                    />
                                </>
                            )}

                            {row.noteType === "שמרים" && (
                                <>
                                    <span>הורדת  </span>
                                    <input
                                        type="text"
                                        className="bucket_input"
                                        value={row.value}
                                        placeholder="כמות"
                                        onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                    />
                                    <span> דליי שמרים, לחץ אחרי </span>
                                    <input
                                        type="number"
                                        value={row.value2}
                                        placeholder="לחץ"
                                        onChange={(e) => updateRow(row.id, { value2: e.target.value })}
                                    />
                                    <span> bar</span>
                                </>
                            )}

                            {row.noteType === "לחץ" && (
                                <>
                                    <select
                                        value={row.direction || ""}
                                        onChange={(e) => updateRow(row.id, { direction: e.target.value })}
                                    >
                                        <option value="" disabled>בחר כיוון</option>
                                        <option value="העלאת">העלאת</option>
                                        <option value="הורדת">הורדת</option>
                                    </select>
                                    <span>  לחץ ל:  </span>
                                    <input
                                        type="number"
                                        value={row.value}
                                        placeholder="לחץ"
                                        onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                    />
                                    <span> bar</span>
                                </>
                            )}

                            {row.noteType === "פורק" && (
                                <>
                                    <span>כיוון פורק ל: </span>
                                    <input
                                        type="number"
                                        value={row.value}
                                        placeholder="לחץ"
                                        onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                    />
                                    <span> bar</span>
                                </>
                            )}

                            {row.noteType === "דיאציטיל" && (
                                <span>חימום מיכל ל14° למנוחת דיאציטיל</span>
                            )}
                            {row.noteType === "קירור" && (
                                <span>קירור מיכל ל0.3°</span>
                            )}
                        </div>

                        {rows.length > 1 && (
                            <button
                                type="button"
                                className="btn-remove-row"
                                onClick={() => removeRow(row.id)}
                            >
                                ✕
                            </button>
                        )}
                    </div>
                );
            })}

            <button type="button" className="btn-add-row" onClick={addRow}>
                + הוסף דיווח
            </button>
        </div>
    )
}