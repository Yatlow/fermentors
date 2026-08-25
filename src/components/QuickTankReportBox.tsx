import { useState } from "react";
import type { Fermentor } from "../App";
import type { SpecChart } from "../SERVICES/getSpecsFromFb";
import { writeReadingsToSheets } from "../SERVICES/writeReadingToSheets";
import { updatePackagingInfo } from "../SERVICES/updatePackagingInfo";
import { resolveFinalPackagingTotal } from "../SERVICES/resolveFinalPackagingTotal";
import { assignDryHopToHopsTable } from "../SERVICES/assignDryHop";
import {
    isDryHopAllowedForStyle,
    getDryHopStyleCategory,
    calcDryHopDose,
    roundGramsUp5,
    getClosingPressureForStyle,
    buildDryHopNoteText,
} from "../SERVICES/dryHopLogic";
import { pushCurrentDataToFirestore } from "../SERVICES/pushCurrentDataToFirestore";
// ⚠️ קובץ חדש - ראה packagingMasterSheetLogger.ts
import { logPackagingToMasterSheet } from "../SERVICES/packagingMasterSheetLogger";

type QuickTankReportBoxProps = {
    tank: Fermentor;
    specs: SpecChart | null;
    onClose: () => void;
    position: { top: number; left: number } | null;
};


const NOTE_TYPES = [
    { value: "גיזוז", label: "בדיקת גיזוז", stage: "cold" },
    { value: "שמרים", label: "הורדת שמרים", stage: "both" },
    { value: "לחץ", label: "שינוי לחץ", stage: "both" },
    { value: "פורק", label: "כיוון פורק", stage: "warm" },
    { value: "דיאציטיל", label: "מנוחת דיאציטיל", stage: "warm" },
    { value: "קירור", label: "קירור", stage: "warm" },
    { value: "דרייהופ", label: "דרייהופ", stage: "warm" },
    { value: "אריזה", label: "אריזה", stage: "cold" },
    { value: "אחר", label: "אחר", stage: "both" },
];

const KEG_LITERS = 20;
const BOTTLE_LITERS = 0.33;

function buildMeasurementId(date: Date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d}_${hh}${mm}`;
}

export default function QuickTankReportBox({ tank, specs, onClose, position }: QuickTankReportBoxProps) {
    const isWarm = Number(tank.currentData?.temp) > 9 && tank.stage?.name === "בתסיסה";
    const stage: "warm" | "cold" = isWarm ? "warm" : "cold";
    const isColdTank = tank.stage?.name === "קר";

    const [noteType, setNoteType] = useState("");
    const [value, setValue] = useState("");
    const [value2, setValue2] = useState("");
    const [direction, setDirection] = useState("");

    const [packagingType, setPackagingType] = useState<"kegs" | "bottles" | "">("");
    const [amount, setAmount] = useState("");
    const [isEmpty, setIsEmpty] = useState(false);

    // --- פיצ'ר 1: הורדת לחץ אחרי אריזה ---
    const [pressureAfter, setPressureAfter] = useState("");
    const [pressureAutoFilled, setPressureAutoFilled] = useState(true);

    const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState("");

    const isSending = status === "sending";

    function resetValues() {
        setValue(""); setValue2(""); setDirection("");
        setPackagingType(""); setAmount(""); setIsEmpty(false);
        setPressureAfter(""); setPressureAutoFilled(true);
        setStatus("idle"); setErrorMsg("");
    }

    function buildNoteText(): string | null {
        switch (noteType) {
            // case "גיזוז": return value === "" ? null : `בדיקת גיזוז: ${value}`;
            case "שמרים": return (value === "" || value2 === "") ? null : `הורדת ${value} דליי שמרים, לחץ אחרי ${value2} bar`;
            case "לחץ": return (direction === "" || value === "") ? null : `${direction} לחץ ל: ${value} bar`;
            case "פורק": return value === "" ? null : `כיוון פורק ל: ${value} bar`;
            case "דיאציטיל": return "חימום מיכל ל14° למנוחת דיאציטיל";
            case "קירור": return "קירור מיכל ל0.3°";
            case "אחר": return value === "" ? null : value;
            case "דרייהופ": {
                if (!specs) return null;
                const category = getDryHopStyleCategory(tank.beerStyle);
                const calc = calcDryHopDose(category, tank.beerVolume);

                const grams = calc.needsManualInput ? Number(value) : roundGramsUp5(calc.grams);
                const hopType = calc.needsManualInput ? value2.trim() : calc.hopType;

                if (calc.needsManualInput && (value === "" || value2.trim() === "")) return null;
                if (!grams || grams <= 0 || !hopType) return null;

                const pressure = getClosingPressureForStyle(tank.beerStyle, specs);
                if (pressure === null) return null;

                return buildDryHopNoteText(grams, hopType, pressure);
            }
            default: return null;
        }
    }

    function getDryHopValues(): { grams: number; hopType: string } | null {
        if (noteType !== "דרייהופ" || !specs) return null;
        const category = getDryHopStyleCategory(tank.beerStyle);
        const calc = calcDryHopDose(category, tank.beerVolume);
        const grams = calc.needsManualInput ? Number(value) : roundGramsUp5(calc.grams);
        const hopType = calc.needsManualInput ? value2.trim() : calc.hopType;
        if (!grams || grams <= 0 || !hopType) return null;
        return { grams, hopType };
    }

    function calcReportLiters(): number {
        const amountNum = Number(amount) || 0;
        if (packagingType === "kegs") return amountNum * KEG_LITERS;
        if (packagingType === "bottles") return amountNum * BOTTLE_LITERS;
        return 0;
    }

    async function submitNote() {
        const noteText = buildNoteText();
        if (noteType !== "גיזוז" && !noteText) return;

        setStatus("sending");
        setErrorMsg("");

        const reading: any = {
            id: buildMeasurementId(),
            tankId: tank.id,
            tankNumber: tank.tankNumber,
            sheetUrl: tank.sheetUrl ?? null,
            notes: noteText,
        };
        if (noteType === "גיזוז") reading.carbonation = value;

        try {
            const res = await writeReadingsToSheets([reading]);
            if (!res.every((r) => r.success)) {
                throw new Error(res.map((r) => r.error ?? r.message).join(", "));
            }

            if (noteType === "דרייהופ" && tank.sheetUrl) {
                const dryHop = getDryHopValues();
                if (dryHop) {
                    try {
                        await assignDryHopToHopsTable(tank.sheetUrl, dryHop.grams, dryHop.hopType);
                    } catch (err) {
                        console.error("Failed to assign dry hop to hops table", err);
                    }
                }
            }
            pushCurrentDataToFirestore([reading]).catch((error) => {
                console.error("Failed to push current data to Firestore:", error);
            });
            setStatus("sent");
            onClose();

        } catch (err: any) {
            setStatus("error");
            setErrorMsg(err?.message ?? "שגיאה בשליחה");
        }
    }

    async function submitPackaging() {
        setStatus("sending");
        setErrorMsg("");

        const reportLiters = calcReportLiters();

        let notes = "";
        if (packagingType === "kegs" && Number(amount) > 0) notes = `הורדת ${amount} חביות`;
        if (packagingType === "bottles" && Number(amount) > 0) notes = `הורדת ${amount} בקבוקים`;

        let totalLiters: number | undefined;
        let shrinkagePercent: number | undefined;

        try {
            if (isEmpty) {
                const result = await resolveFinalPackagingTotal(
                    packagingType === "kegs" ? "kegs" : "bottles", tank, reportLiters
                );
                totalLiters = result.totalLiters;
                shrinkagePercent = result.shrinkagePercent ?? undefined;

                const shrinkageText = shrinkagePercent !== undefined
                    ? `\nסה"כ ${totalLiters.toFixed(2)} ליטר, פחת ${shrinkagePercent.toFixed(2)}%`
                    : `סה"כ ${totalLiters.toFixed(2)} ליטר`;

                notes = notes ? `${notes} | ${shrinkageText}` : shrinkageText;
            } else if (reportLiters > 0) {
                notes = notes ? `${notes}, סה"כ ${reportLiters.toFixed(2)} ליטר` : `סה"כ ${reportLiters.toFixed(2)} ליטר`;
            }

            // --- פיצ'ר 1: הוספת טקסט הורדת לחץ (רק אם המיכל לא ריק) ---
            const hasValidPressure = pressureAfter !== "" && !Number.isNaN(Number(pressureAfter));
            if (!isEmpty && hasValidPressure) {
                const pressureText = `הורדת לחץ ל-${pressureAfter}`;
                notes = notes ? `${notes} | ${pressureText}` : pressureText;
            }

            const reading: any = {
                id: buildMeasurementId(),
                tankId: tank.id,
                tankNumber: tank.tankNumber,
                sheetUrl: tank.sheetUrl ?? null,
                boldNotes: true,
                notes: notes || undefined,
                isEmpty: isEmpty ? true : undefined,
                kegs: packagingType === "kegs" && reportLiters > 0 ? reportLiters : undefined,
                crates: packagingType === "bottles" && reportLiters > 0 ? reportLiters : undefined,
                // רושמים גם את הלחץ החדש כמדידת לחץ רגילה של המיכל
                pressure: !isEmpty && hasValidPressure ? Number(pressureAfter) : undefined,
            };

            const res = await writeReadingsToSheets([reading]);
            if (!res.every((r) => r.success)) {
                throw new Error(res.map((r) => r.error ?? r.message).join(", "));
            }

            await updatePackagingInfo([{
                tankId: tank.id,
                tankNumber: tank.tankNumber ?? undefined,
                sheetUrl: tank.sheetUrl ?? null,
                isEmpty: reading.isEmpty,
                kegs: reading.kegs,
                crates: reading.crates,
                totalLiters,
                shrinkagePercent,
            }]);
            pushCurrentDataToFirestore([reading]).catch((error) => {
                console.error("Failed to push current data to Firestore:", error);
            });

            // --- פיצ'ר 2: כתיבה לטבלת המאסטר (לא חוסם את זרימת השליחה הרגילה) ---
            if (packagingType && Number(amount) > 0) {
                logPackagingToMasterSheet({
                    beerStyle: tank.beerStyle,
                    packagingType,
                    amount: Number(amount),
                    batchNumber: tank.batchNumber,
                }).catch((err) => {
                    console.error("Failed to log packaging to master sheet:", err);
                });
            }

            setStatus("sent");
            onClose()
        } catch (err: any) {
            setStatus("error");
            setErrorMsg(err?.message ?? "שגיאה בשליחה");
        }
    }

    function handleSubmit() {
        if (noteType === "אריזה") void submitPackaging();
        else void submitNote();
    }
    const canSubmit =
        noteType === "אריזה"
            ? (!!packagingType && amount !== "") || isEmpty
            : noteType === "גיזוז"
                ? value !== ""
                : buildNoteText() !== null;

    const dryHopCategory = noteType === "דרייהופ" ? getDryHopStyleCategory(tank.beerStyle) : null;
    const dryHopCalc = dryHopCategory ? calcDryHopDose(dryHopCategory, tank.beerVolume) : null;
    const dryHopPressure = specs ? getClosingPressureForStyle(tank.beerStyle, specs) : null;

    return (
        <div
            className="fermentorInfoOverlay"
            onClick={() => { if (!isSending) onClose(); }} // לא לסגור בטעות תוך כדי שליחה
        >
            <div
                className="fermentorInfoBox quickReportBox"
                style={position ? { top: position.top, left: position.left } : undefined}
                onClick={(e) => e.stopPropagation()}
            >
                <button className="fermentorInfoClose" onClick={onClose} disabled={isSending}>×</button>
                <h3>דיווח מהיר- מיכל {tank.tankNumber}</h3>

                <div className="quickReportForm">
                    <select
                        className="quickReportSelect"
                        value={noteType}
                        disabled={isSending}
                        onChange={(e) => { setNoteType(e.target.value); resetValues(); }}
                    >
                        <option value="" disabled>בחר סוג דיווח</option>
                        {NOTE_TYPES
                            .filter((t) => t.stage === "both" || t.stage === stage)
                            .filter((t) => t.value !== "דרייהופ" || isDryHopAllowedForStyle(tank.beerStyle))
                            .filter((t) => t.value !== "אריזה" || isColdTank)
                            .map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                    </select>

                    {noteType === "אחר" && (
                        <input type="text" placeholder="כתוב הערה" value={value} disabled={isSending}
                            onChange={(e) => setValue(e.target.value)} />
                    )}

                    {noteType === "גיזוז" && (
                        <input type="number" min={0} max={15} placeholder="גיזוז" value={value} disabled={isSending}
                            onChange={(e) => setValue(e.target.value)} />
                    )}

                    {noteType === "שמרים" && (
                        <div className="quickReportInline">
                            <input type="text" placeholder="כמות דליים" value={value} disabled={isSending}
                                onChange={(e) => setValue(e.target.value)} />
                            <span>לחץ אחרי</span>
                            <input type="number" placeholder="לחץ" value={value2} disabled={isSending}
                                onChange={(e) => setValue2(e.target.value)} />
                        </div>
                    )}

                    {noteType === "לחץ" && (
                        <div className="quickReportInline">
                            <select value={direction} disabled={isSending} onChange={(e) => setDirection(e.target.value)}>
                                <option value="" disabled>בחר כיוון</option>
                                <option value="העלאת">העלאת</option>
                                <option value="הורדת">הורדת</option>
                            </select>
                            <input type="number" placeholder="לחץ" value={value} disabled={isSending}
                                onChange={(e) => setValue(e.target.value)} />
                        </div>
                    )}

                    {noteType === "פורק" && (
                        <input type="number" placeholder="לחץ" value={value} disabled={isSending}
                            onChange={(e) => setValue(e.target.value)} />
                    )}

                    {noteType === "דרייהופ" && dryHopCalc && (
                        dryHopCalc.needsManualInput ? (
                            <div className="quickReportInline">
                                <input type="number" placeholder="גרם" value={value} disabled={isSending}
                                    onChange={(e) => setValue(e.target.value)} />
                                <input type="text" placeholder="סוג כשות" value={value2} disabled={isSending}
                                    onChange={(e) => setValue2(e.target.value)} />
                            </div>
                        ) : (
                            <div className="quickReportDryHopPreview">
                                הכנסת כשות 4: {roundGramsUp5(dryHopCalc.grams)} גרם {dryHopCalc.hopType}, סגירת לחץ, כיוון פורק ל{dryHopPressure ?? "—"} bar
                            </div>
                        )
                    )}

                    {noteType === "אריזה" && (
                        <div className="quickReportPackaging">
                            <select
                                className="quickReportSelect"
                                value={packagingType}
                                disabled={isSending}
                                onChange={(e) => {
                                    const pt = e.target.value as "kegs" | "bottles";
                                    setPackagingType(pt);
                                    setAmount("");
                                    // פיצ'ר 1: ברירת מחדל = הלחץ הנוכחי של המיכל
                                    setPressureAfter(
                                        tank.currentData?.pressure !== undefined && tank.currentData?.pressure !== null
                                            ? String(tank.currentData.pressure)
                                            : ""
                                    );
                                    setPressureAutoFilled(true);
                                }}
                            >
                                <option value="" disabled>סוג אריזה</option>
                                <option value="kegs">חביות</option>
                                <option value="bottles">בקבוקים</option>
                            </select>
                            {packagingType && (
                                <input type="number" min={0} placeholder={`כמות ${packagingType === "kegs" ? "חביות" : "בקבוקים"}`} value={amount} disabled={isSending}
                                    onChange={(e) => setAmount(e.target.value)} />
                            )}

                            {/* פיצ'ר 1: הורדת לחץ - רק כשהמיכל לא מסומן כריק */}
                            {packagingType && !isEmpty && (
                                <div className="quickReportInline quickReportPressureRow">
                                    <span>הורדת לחץ ל: </span>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={pressureAfter}
                                        disabled={isSending}
                                        className={pressureAutoFilled ? "auto-filled-value" : undefined}
                                        onChange={(e) => {
                                            setPressureAfter(e.target.value);
                                            setPressureAutoFilled(false);
                                        }}
                                    />
                                    {pressureAutoFilled && pressureAfter !== "" && (
                                        <span
                                            className="auto-filled-hint"
                                            title="לחץ לפני אריזה - ניתן לשנות"
                                        >
                                            לחץ לפני אריזה
                                        </span>
                                    )}
                                </div>
                            )}

                            <label className="quickReportCheckbox">
                                <input type="checkbox" checked={isEmpty} disabled={isSending}
                                    onChange={(e) => setIsEmpty(e.target.checked)} />
                                <span>המיכל ריק</span>
                            </label>
                        </div>
                    )}

                    <button
                        className="btn-primary quickReportSubmit"
                        disabled={!canSubmit || isSending}
                        onClick={handleSubmit}
                    >
                        {isSending ? <span className="quickReportSpinner" /> : "שלח"}
                    </button>
                </div>

                {status === "sent" && <p className="status-sent">נשלח בהצלחה</p>}
                {status === "error" && <p className="status-error">שגיאה: {errorMsg}</p>}
            </div>
        </div>
    );
}
