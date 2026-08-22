import { useState } from "react";
import type { Fermentor } from "../App";

export type PackagingFormProps = {
    brews: Fermentor[];
    updateReading: Function;
    onValidityChange?: (hasIncompleteRow: boolean) => void;
};

type PackagingType = "kegs" | "bottles";

type PackagingRow = {
    id: number;
    tankNumber: number | "";
    packagingType: PackagingType | "";
    amount: string;
    isEmpty: boolean;
};

const KEG_LITERS = 20;
const BOTTLE_LITERS = 0.330*24;

let rowIdCounter = 0;
function makeEmptyRow(): PackagingRow {
    return {
        id: rowIdCounter++,
        tankNumber: "",
        packagingType: "",
        amount: "",
        isEmpty: false,
    };
}

export default function PackagingForm({
    brews,
    updateReading,
    onValidityChange,
}: PackagingFormProps) {

    const [rows, setRows] = useState<PackagingRow[]>([makeEmptyRow()]);

    const availableTanks = brews.filter(
        (fv) => Number(fv.tankNumber) !== 1 && Number(fv.action) === 1 && fv?.stage?.name==="קר"
    );

    function calcReportLiters(row: PackagingRow): number {
        const amountNum = Number(row.amount) || 0;
        if (row.packagingType === "kegs") return amountNum * KEG_LITERS;
        if (row.packagingType === "bottles") return amountNum * BOTTLE_LITERS;
        return 0;
    }

    function isRowIncomplete(row: PackagingRow): boolean {
        if (!row.tankNumber) return false;
        const hasAmount = row.packagingType !== "" && row.amount !== "";
        return !hasAmount && !row.isEmpty;
    }

    function buildNoteText(row: PackagingRow): string | null {
        const reportLiters = calcReportLiters(row);

        if (reportLiters === 0 && !row.isEmpty) return null;

        const parts: string[] = [];

        if (row.packagingType === "kegs" && Number(row.amount) > 0) {
            parts.push(`הורדת ${row.amount} חביות`);
        }
        if (row.packagingType === "bottles" && Number(row.amount) > 0) {
            parts.push(`הורדת ${row.amount} בקבוקים`);
        }

        let text = parts.join(", ");

        if (reportLiters > 0) {
            text += `${text ? " ," : ""}סה"כ ${reportLiters.toFixed(2)} ליטר`;
        }

        return text || null;
    }

    function handleRowsUpdate(newRows: PackagingRow[]) {
        setRows(newRows);

        const byTank = new Map<number, PackagingRow>();
        newRows.forEach((row) => {
            if (!row.tankNumber) return;
            byTank.set(Number(row.tankNumber), row);
        });

        availableTanks.forEach((fv) => {
            const tankNum = Number(fv.tankNumber);
            const row = byTank.get(tankNum);

            if (!row) {
                updateReading(fv.id, "notes", undefined);
                updateReading(fv.id, "isEmpty", undefined);
                updateReading(fv.id, "kegs", undefined);
                updateReading(fv.id, "crates", undefined);
                return;
            }

            const noteText = buildNoteText(row);
            const reportLiters = calcReportLiters(row);

            updateReading(fv.id, "notes", noteText ?? undefined);
            updateReading(fv.id, "isEmpty", row.isEmpty ? true : undefined);
            updateReading(
                fv.id,
                "kegs",
                row.packagingType === "kegs" && reportLiters > 0 ? reportLiters : undefined
            );
            updateReading(
                fv.id,
                "crates",
                row.packagingType === "bottles" && reportLiters > 0 ? reportLiters : undefined
            );
        });

        onValidityChange?.(newRows.some(isRowIncomplete));
    }

    function patchRow(rowId: number, patch: Partial<PackagingRow>) {
        handleRowsUpdate(
            rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row))
        );
    }

    return (
        <div className="note-RowsBox">
            {rows.map((row) => {
                const fermentor = brews.find(
                    (fv) => Number(fv.tankNumber) === Number(row.tankNumber)
                );
                const reportLiters = calcReportLiters(row);

                return (
                    <div className="write-note-row note-cold" key={row.id}>
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
                                    patchRow(row.id, { tankNumber: Number(selected.tankNumber) });
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
                            onChange={(e) => patchRow(row.id, { tankNumber: Number(e.target.value) })}
                        >
                            <option value="" disabled>בחר מיכל</option>
                            {availableTanks.map((fv) => (
                                <option key={fv.id} value={fv?.tankNumber ?? ""}>
                                    מיכל {fv.tankNumber}
                                </option>
                            ))}
                        </select>

                        {fermentor && <span className="note-style">{fermentor.beerStyle}</span>}

                        <select
                            value={row.packagingType}
                            onChange={(e) =>
                                patchRow(row.id, { packagingType: e.target.value as PackagingType, amount: "" })
                            }
                        >
                            <option value="" disabled>סוג אריזה</option>
                            <option value="kegs">חביות</option>
                            <option value="bottles">בקבוקים</option>
                        </select>

                        {row.packagingType && (
                            <>
                                <span>{row.packagingType === "kegs" ? "כמות חביות: " : "כמות ארגזים: "}</span>
                                <input
                                    type="number"
                                    min={0}
                                    value={row.amount}
                                    onChange={(e) => patchRow(row.id, { amount: e.target.value })}
                                />
                            </>
                        )}

                        {reportLiters > 0 && (
                            <span className="report-liters-preview">
                                {`   (סה"כ ${reportLiters.toFixed(2)}  ליטר)`}
                            </span>
                        )}

                        <label className="empty-checkbox-label">
                            <input
                                type="checkbox"
                                checked={row.isEmpty}
                                onChange={(e) => patchRow(row.id, { isEmpty: e.target.checked })}
                            />
                            <span> המיכל ריק</span>
                        </label>
                    </div>
                );
            })}
        </div>
    );
}