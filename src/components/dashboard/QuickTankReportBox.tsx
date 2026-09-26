import BeerLoader from "../general/Loading";
import { useEffect, useRef, useState } from "react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { writeReadingsToSheets } from "../../SERVICES/getAndPost/writeReadingToSheets";
import { updatePackagingInfo } from "../../SERVICES/cellering/updatePackagingInfo";
import { resolveFinalPackagingTotal } from "../../SERVICES/cellering/resolveFinalPackagingTotal";
import { assignDryHopToHopsTable } from "../../SERVICES/cellering/assignDryHop";
import {
    isDryHopAllowedForStyle,
    getDryHopStyleCategory,
    calcDryHopDose,
    roundGramsUp5,
    getClosingPressureForStyle,
    getHopAa,
    isValidHopAa,
    buildDryHopNoteText,
} from "../../SERVICES/cellering/dryHopLogic";
import {
    DEFAULT_BOTTOM_CARBONATION_PRESSURE,
    buildBottomCarbonationCloseNote,
    buildBottomCarbonationStartNote,
    formatClockTime,
} from "../../SERVICES/cellering/bottomCarbonation";
import { pushCurrentDataToFirestore } from "../../SERVICES/getAndPost/pushCurrentDataToFirestore";
import PackagingPalletsModal from "../cooler/PackagingPalletsModal";
import type { PackagingJobInput } from "../../SERVICES/cooler/usePackagingPalletsFlow";
import {
    Bubbles,
    BottleWine,
    ChevronDown,
    CircleArrowOutUpRight,
    ClockPlus,
    FlaskConical,
    Hop,
    PencilSparkles,
    Stethoscope,
    ThermometerSnowflake,
    ThermometerSun,
    createLucideIcon,
    type LucideIcon,
} from "lucide-react";

type QuickTankReportBoxProps = {
    tank: Fermentor;
    specs: SpecChart | null;
    onClose: () => void;
    position: { top: number; left: number } | null;
};

const RobotVacuum = createLucideIcon("RobotVacuum", [
    ["circle", { cx: "12", cy: "12", r: "8.5", key: "body" }],
    ["path", { d: "M7.5 15.5h9", key: "bumper" }],
    ["circle", { cx: "12", cy: "10", r: "1.4", key: "sensor" }],
    ["path", { d: "M5 12h-1.5M20.5 12H19", key: "brushes" }],
]);

type QuickReportType = {
    value: string;
    label: string;
    stage: "warm" | "cold" | "both";
    icon: LucideIcon;
};

const NOTE_TYPES: QuickReportType[] = [
    { value: "סגירת מיכל", label: "סגירת מיכל", stage: "warm", icon: RobotVacuum },
    { value: "גיזוז", label: "בדיקת גיזוז", stage: "cold", icon: Bubbles },
    { value: "גיזוז מלמטה התחלה", label: "תחילת גיזוז מלמטה", stage: "cold", icon: Stethoscope },
    { value: "גיזוז מלמטה סגירה", label: "סגירת גיזוז מלמטה", stage: "cold", icon: Stethoscope },
    { value: "שמרים", label: "הורדת שמרים", stage: "both", icon: FlaskConical },
    { value: "לחץ", label: "שינוי לחץ", stage: "both", icon: ClockPlus },
    { value: "פורק", label: "כיוון פורק", stage: "warm", icon: CircleArrowOutUpRight },
    { value: "דיאציטיל", label: "מנוחת דיאצטיל", stage: "warm", icon: ThermometerSun },
    { value: "קירור", label: "קירור", stage: "warm", icon: ThermometerSnowflake },
    { value: "דרייהופ", label: "דרייהופ", stage: "warm", icon: Hop },
    { value: "אריזה", label: "אריזה", stage: "cold", icon: BottleWine },
    { value: "אחר", label: "אחר", stage: "both", icon: PencilSparkles },
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
    const [reportTypeOpen, setReportTypeOpen] = useState(false);
    const [value, setValue] = useState("");
    const [value2, setValue2] = useState("");
    const [dryHopAa, setDryHopAa] = useState("");
    const [direction, setDirection] = useState("");

    const [packagingType, setPackagingType] = useState<"kegs" | "bottles" | "">("");
    const [amount, setAmount] = useState("");
    const [isEmpty, setIsEmpty] = useState(false);

    const [pressureAfter, setPressureAfter] = useState("");
    const [pressureAutoFilled, setPressureAutoFilled] = useState(true);

    const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
    const [errorMsg, setErrorMsg] = useState("");

    const [packagingJob, setPackagingJob] = useState<PackagingJobInput | null>(null);
    const submitInFlightRef = useRef(false);

    const isSending = status === "sending";

    useEffect(() => {
        if (noteType !== "דרייהופ" || !specs || dryHopAa !== "") return;

        const category = getDryHopStyleCategory(tank.beerStyle);
        const calc = calcDryHopDose(category, tank.beerVolume);
        if (calc.needsManualInput || !calc.hopType) return;

        const defaultAa = getHopAa(calc.hopType, specs);
        if (defaultAa !== null) setDryHopAa(String(defaultAa));
    }, [noteType, specs, dryHopAa, tank.beerStyle, tank.beerVolume]);

    function resolveDryHopAaValue(): string {
        if (dryHopAa !== "") return dryHopAa;
        if (noteType !== "דרייהופ" || !specs) return "";

        const category = getDryHopStyleCategory(tank.beerStyle);
        const calc = calcDryHopDose(category, tank.beerVolume);
        const hopType = calc.needsManualInput ? value2.trim() : calc.hopType;
        if (!hopType) return "";

        const defaultAa = getHopAa(hopType, specs);
        return defaultAa !== null ? String(defaultAa) : "";
    }

    function resetValues() {
        setValue(""); setValue2(""); setDryHopAa(""); setDirection("");
        setPackagingType(""); setAmount(""); setIsEmpty(false);
        setPressureAfter(""); setPressureAutoFilled(true);
        setStatus("idle"); setErrorMsg("");
    }

    function selectNoteType(newType: string) {
        setNoteType(newType);
        setReportTypeOpen(false);
        resetValues();

        if (newType === "סגירת מיכל" && closingPressure !== null) {
            setValue(String(closingPressure));
        }
        if (newType === "גיזוז מלמטה התחלה") {
            setValue(String(DEFAULT_BOTTOM_CARBONATION_PRESSURE));
            setValue2(formatClockTime());
        }
        if (newType === "גיזוז מלמטה סגירה") {
            setValue(
                tank.currentData?.pressure !== undefined && tank.currentData?.pressure !== null
                    ? String(tank.currentData.pressure)
                    : ""
            );
            setValue2(formatClockTime());
        }

        if (newType === "דרייהופ" && specs) {
            const category = getDryHopStyleCategory(tank.beerStyle);
            const calc = calcDryHopDose(category, tank.beerVolume);
            if (!calc.needsManualInput) {
                const defaultAa = getHopAa(calc.hopType, specs);
                setDryHopAa(defaultAa !== null ? String(defaultAa) : "");
            }
        }
    }

    function buildNoteText(): string | null {
        switch (noteType) {
            case "שמרים": return (value === "" || value2 === "") ? null : `הורדת ${value} דליי שמרים, לחץ אחרי ${value2} bar`;
            case "לחץ": return (direction === "" || value === "") ? null : `${direction} לחץ ל: ${value} bar`;
            case "פורק": return value === "" ? null : `כיוון פורק ל: ${value} bar`;
            case "סגירת מיכל": return value === "" ? null : `סגירת נשם, כיוון פורק ל ${value}`;
            case "גיזוז מלמטה התחלה":
                return value === "" || value2 === "" ? null : buildBottomCarbonationStartNote(value, value2);
            case "גיזוז מלמטה סגירה":
                return value === "" || value2 === "" ? null : buildBottomCarbonationCloseNote(value, value2);
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
                if (!grams || grams <= 0 || !hopType || !isValidHopAa(resolveDryHopAaValue())) return null;

                const pressure = getClosingPressureForStyle(tank.beerStyle, specs);
                if (pressure === null) return null;

                return buildDryHopNoteText(grams, hopType, pressure);
            }
            default: return null;
        }
    }

    function getDryHopValues(): { grams: number; hopType: string; aa: number } | null {
        if (noteType !== "דרייהופ" || !specs) return null;
        const category = getDryHopStyleCategory(tank.beerStyle);
        const calc = calcDryHopDose(category, tank.beerVolume);
        const grams = calc.needsManualInput ? Number(value) : roundGramsUp5(calc.grams);
        const hopType = calc.needsManualInput ? value2.trim() : calc.hopType;
        const aa = Number(resolveDryHopAaValue());
        if (!grams || grams <= 0 || !hopType || !isValidHopAa(aa)) return null;
        return { grams, hopType, aa };
    }

    function calcReportLiters(): number {
        const amountNum = Number(amount) || 0;
        if (packagingType === "kegs") return amountNum * KEG_LITERS;
        if (packagingType === "bottles") return amountNum * BOTTLE_LITERS;
        return 0;
    }

    async function submitNote() {
        if (submitInFlightRef.current) return;
        const noteText = buildNoteText();
        if (noteType !== "גיזוז" && !noteText) return;

        submitInFlightRef.current = true;
        setStatus("sending");
        setErrorMsg("");

        const reading: any = {
            id: buildMeasurementId(),
            tankId: tank.id,
            tankNumber: tank.tankNumber,
            batchNumber: tank.batchNumber,
            sheetUrl: tank.sheetUrl ?? null,
            notes: noteText,
        };
        if (noteType === "גיזוז") reading.carbonation = value;
        if (noteType === "גיזוז מלמטה התחלה" || noteType === "גיזוז מלמטה סגירה") {
            reading.pressure = Number(value);
        }

        try {
            const res = await writeReadingsToSheets([reading]);
            if (!res.every((r) => r.success)) {
                throw new Error(res.map((r) => r.error ?? r.message).join(", "));
            }

            if (noteType === "דרייהופ" && tank.sheetUrl) {
                const dryHop = getDryHopValues();
                if (dryHop) {
                    try {
                        await assignDryHopToHopsTable(
                            tank.sheetUrl,
                            dryHop.grams,
                            dryHop.hopType,
                            dryHop.aa
                        );
                    } catch (err) {
                        console.error("Failed to assign dry hop to hops table", err);
                        await pushCurrentDataToFirestore([{
                            ...reading,
                            sheetResult: res.find((r) => r.success)?.result,
                        }]);
                        setStatus("error");
                        setErrorMsg("הדיווח נשמר, אך עדכון טבלת הכשות נכשל. אין לשלוח שוב; יש לבדוק את גיליון הבישול.");
                        return;
                    }
                }
            }

            const successfulResult = res.find(
                (result) => result.success === true && String(result.tankId) === String(tank.id)
            );

            await pushCurrentDataToFirestore([{
                ...reading,
                sheetResult: successfulResult?.result,
            }]);
            setStatus("sent");
            onClose();

        } catch (err: any) {
            setStatus("error");
            setErrorMsg(err?.message ?? "שגיאה בשליחה");
        } finally {
            submitInFlightRef.current = false;
        }
    }

    function buildPackagingJobInput(): PackagingJobInput | null {
        if (!packagingType || !(Number(amount) > 0)) return null;
        return {
            submissionId: crypto.randomUUID(),
            tankId: tank.id,
            tankNumber: tank.tankNumber ?? "",
            beerStyle: tank.beerStyle,
            packagingType,
            amount: Number(amount),
            batchNumber: tank.batchNumber,
            tankStatus: isEmpty,
        };
    }

    async function submitPackaging() {
        const job = buildPackagingJobInput();
        if (job) {
            setPackagingJob(job);
        } else {
            setStatus("sending");
            setErrorMsg("");
        }

        void writeMeasurementReading(job !== null);
    }

    async function writeMeasurementReading(handedOffToPalletsModal: boolean) {
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
                    ? `שהם ${reportLiters} ליטר\nסה"כ ${totalLiters.toFixed(2)} ליטר, פחת ${shrinkagePercent.toFixed(2)}%`
                    : `סה"כ ${totalLiters.toFixed(2)} ליטר`;

                notes = notes ? `${notes} | ${shrinkageText}` : shrinkageText;
            } else if (reportLiters > 0) {
                notes = notes ? `${notes}, סה"כ ${reportLiters.toFixed(2)} ליטר` : `סה"כ ${reportLiters.toFixed(2)} ליטר`;
            }

            const hasValidPressure = pressureAfter !== "" && !Number.isNaN(Number(pressureAfter));
            if (!isEmpty && hasValidPressure) {
                const pressureText = `הורדת לחץ ל-${pressureAfter}`;
                notes = notes ? `${notes} | ${pressureText}` : pressureText;
            }

            const reading: any = {
                id: buildMeasurementId(),
                tankId: tank.id,
                tankNumber: tank.tankNumber,
                batchNumber: tank.batchNumber,
                sheetUrl: tank.sheetUrl ?? null,
                boldNotes: true,
                notes: notes || undefined,
                isEmpty: isEmpty ? true : undefined,
                kegs: packagingType === "kegs" && reportLiters > 0 ? reportLiters : undefined,
                crates: packagingType === "bottles" && reportLiters > 0 ? reportLiters : undefined,
                pressure: !isEmpty && hasValidPressure ? Number(pressureAfter) : undefined,
                totalLiters,
                shrinkagePercent,
            };

            const res = await writeReadingsToSheets([reading]);
            if (!res.every((r) => r.success)) {
                throw new Error(res.map((r) => r.error ?? r.message).join(", "));
            }

            const successfulResult = res.find(
                (result) => result.success === true && String(result.tankId) === String(tank.id)
            );

            await pushCurrentDataToFirestore([{
                ...reading,
                sheetResult: successfulResult?.result,
            }]);

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

            if (!handedOffToPalletsModal) {
                setStatus("sent");
                onClose();
            }
        } catch (err: any) {
            if (handedOffToPalletsModal) {
                console.error("Failed to write packaging measurement reading:", err);
            } else {
                setStatus("error");
                setErrorMsg(err?.message ?? "שגיאה בשליחה");
            }
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
    const closingPressure = specs
        ? getClosingPressureForStyle(tank.beerStyle, specs)
        : null;
    const availableNoteTypes = NOTE_TYPES
        .filter((t) => t.stage === "both" || t.stage === stage)
        .filter((t) => t.value !== "דרייהופ" || isDryHopAllowedForStyle(tank.beerStyle))
        .filter((t) => t.value !== "אריזה" || isColdTank);
    const selectedNoteType = availableNoteTypes.find((type) => type.value === noteType);
    const SelectedNoteIcon = selectedNoteType?.icon;

    return (
        <>
            {!packagingJob && (
                <div
                    className="fermentorInfoOverlay"
                    onClick={() => { if (!isSending) onClose(); }}
                >
                    <div
                        className="fermentorInfoBox quickReportBox"
                        style={position ? { top: position.top, left: position.left } : undefined}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button className="fermentorInfoClose" onClick={onClose} disabled={isSending}>×</button>
                        <h3>דיווח מהיר- מיכל {tank.tankNumber}</h3>

                        <div className="quickReportForm">
                            <div className="quickReportDropdown">
                                <button
                                    type="button"
                                    className="quickReportDropdownTrigger"
                                    aria-haspopup="listbox"
                                    aria-expanded={reportTypeOpen}
                                    disabled={isSending}
                                    onClick={() => setReportTypeOpen((open) => !open)}
                                >
                                    <span className="quickReportDropdownValue">
                                        {SelectedNoteIcon && <SelectedNoteIcon size={17} aria-hidden="true" />}
                                        <span>{selectedNoteType?.label ?? "בחר סוג דיווח"}</span>
                                    </span>
                                    <ChevronDown className={reportTypeOpen ? "is-open" : ""} size={17} aria-hidden="true" />
                                </button>

                                {reportTypeOpen && (
                                    <div className="quickReportDropdownMenu" role="listbox" aria-label="סוג דיווח">
                                        {availableNoteTypes.map((type) => {
                                            const Icon = type.icon;
                                            return (
                                                <button
                                                    key={type.value}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={noteType === type.value}
                                                    className={`quickReportDropdownOption ${noteType === type.value ? "selected" : ""}`}
                                                    onClick={() => selectNoteType(type.value)}
                                                >
                                                    <Icon size={18} aria-hidden="true" />
                                                    <span>{type.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {noteType === "אחר" && (
                                <input type="text" placeholder="כתוב הערה" value={value} disabled={isSending}
                                    onChange={(e) => setValue(e.target.value)} />
                            )}
                            {noteType === "סגירת מיכל" && (
                                <div className="quickReportInline">
                                    <span>סגירת נשם, כיוון פורק ל:</span>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={value}
                                        placeholder="לחץ"
                                        disabled={isSending}
                                        onChange={(e) => setValue(e.target.value)}
                                    />
                                    <span> bar </span>
                                </div>
                            )}

                            {noteType === "גיזוז" && (
                                <input type="number" min={0} max={15} placeholder="גיזוז" value={value} disabled={isSending}
                                    onChange={(e) => setValue(e.target.value)} />
                            )}

                            {(noteType === "גיזוז מלמטה התחלה" || noteType === "גיזוז מלמטה סגירה") && (
                                <div className="quickReportInline">
                                    <span>{noteType === "גיזוז מלמטה התחלה" ? "לחץ" : "לחץ בסגירה"}</span>
                                    <input
                                        type="number"
                                        step="0.1"
                                        min={0}
                                        value={value}
                                        disabled={isSending}
                                        onChange={(e) => setValue(e.target.value)}
                                    />
                                    <span>bar</span>
                                    <span>שעה</span>
                                    <input
                                        type="time"
                                        value={value2}
                                        disabled={isSending}
                                        onChange={(e) => setValue2(e.target.value)}
                                    />
                                </div>
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
                                        <input
                                            type="text"
                                            placeholder="סוג כשות"
                                            value={value2}
                                            disabled={isSending}
                                            onChange={(e) => {
                                                const hopType = e.target.value;
                                                setValue2(hopType);
                                                const defaultAa = specs ? getHopAa(hopType, specs) : null;
                                                setDryHopAa(defaultAa !== null ? String(defaultAa) : "");
                                            }}
                                        />
                                        <input
                                            type="number"
                                            step="0.1"
                                            min={0}
                                            max={100}
                                            placeholder="aa"
                                            value={resolveDryHopAaValue()}
                                            disabled={isSending}
                                            onChange={(e) => setDryHopAa(e.target.value)}
                                        />
                                        <span>%aa</span>
                                    </div>
                                ) : (
                                    <div className="quickReportDryHopPreview">
                                        <span>הכנסת כשות 4: {roundGramsUp5(dryHopCalc.grams)} גרם {dryHopCalc.hopType} </span>
                                        <input
                                            type="number"
                                            step="0.1"
                                            min={0}
                                            max={100}
                                            placeholder="aa"
                                            value={resolveDryHopAaValue()}
                                            disabled={isSending}
                                            onChange={(e) => setDryHopAa(e.target.value)}
                                        />
                                        <span>%aa, סגירת לחץ, כיוון פורק ל{dryHopPressure ?? "—"} bar</span>
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
                                type="button"
                            >
                                {isSending ? <BeerLoader message="" size="spinner" /> : "שלח"}
                            </button>
                        </div>

                        {status === "sent" && <p className="status-sent">נשלח בהצלחה</p>}
                        {status === "error" && <p className="status-error">שגיאה: {errorMsg}</p>}
                    </div>
                </div>
            )}

            {packagingJob && (
                <PackagingPalletsModal
                    jobs={[packagingJob]}
                    onFinished={() => {
                        setPackagingJob(null);
                        onClose();
                    }}
                />
            )}
        </>
    );
}