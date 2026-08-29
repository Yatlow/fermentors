import { useMemo, useState } from "react";
import type { Fermentor } from "../App";
import {
    checkBatchAssignment,
    findNextBatchForTank,
    extractBatchFromFilename,
    assignAndRefreshTank,
    type BatchCheckResult,
    type NextBatchResult,
} from "../SERVICES/manualBatch";
import { openSheetsPicker, type PickedFile } from "../SERVICES/googleDrivePicker";

type Step =
    | "select"
    | "confirmWarning1"
    | "checking"
    | "confirmIssues"
    | "chooseStatus"
    | "submitting"
    | "done"
    | "error";

type StatusOption = {
    label: string;
    helper?: string;
    action: number;
    tankStatus: boolean;
    color: string;
};

const STATUS_OPTIONS: StatusOption[] = [
    { label: "בישול חדש", action: 0, tankStatus: false, color: "#eab308" },
    {
        label: "מלא",
        helper: "יוצג לבד כ'בתסיסה'/'קר' לפי טמפ' בפועל",
        action: 1,
        tankStatus: false,
        color: "#f97316",
    },
    { label: "מלוכלך", action: 3, tankStatus: true, color: "#6b21a8" },
    { label: "נקי", action: 4, tankStatus: true, color: "#166534" },
    { label: "מחוטא", action: 5, tankStatus: true, color: "#9f1239" },
];

const STEP_ORDER: Step[] = [
    "select",
    "confirmWarning1",
    "checking",
    "chooseStatus",
    "submitting",
    "done",
];

const STEP_LABELS: Record<Step, string> = {
    select: "בחירה",
    confirmWarning1: "אזהרה",
    checking: "בדיקה",
    confirmIssues: "בדיקה",
    chooseStatus: "סטטוס",
    submitting: "שולח",
    done: "הושלם",
    error: "שגיאה",
};

type Props = {
    brews: Fermentor[];
};

export default function ManualBatchAssignment({ brews }: Props) {
    const [selectedTankId, setSelectedTankId] = useState<string>("");
    const [step, setStep] = useState<Step>("select");
    const [picked, setPicked] = useState<PickedFile | null>(null);
    const [checkResult, setCheckResult] = useState<BatchCheckResult | null>(null);
    const [betterBatch, setBetterBatch] = useState<NextBatchResult>(null);
    const [errorMsg, setErrorMsg] = useState<string>("");
    const [pickerBusy, setPickerBusy] = useState(false);

    const tanks = useMemo(
        () => brews.filter((tank) => Number(tank.tankNumber) !== 1),
        [brews]
    );

    const selectedTank = tanks.find((tank) => tank.id === selectedTankId) || null;

    function resetFlow() {
        setStep("select");
        setPicked(null);
        setCheckResult(null);
        setBetterBatch(null);
        setErrorMsg("");
    }

    function handleSelectTank(id: string) {
        setSelectedTankId(id);
        resetFlow();
    }

    async function handlePickFile() {
        try {
            setPickerBusy(true);
            const file = await openSheetsPicker();
            setPickerBusy(false);
            if (!file) return;

            const batch = extractBatchFromFilename(file.name);
            if (batch === null) {
                setErrorMsg(
                    `לא זוהה מספר אצווה בשם הקובץ "${file.name}". יש לבחור קובץ ששמו כולל # ולפחות 4 ספרות (למשל 1578#).`
                );
                setStep("error");
                return;
            }

            setPicked(file);
            setStep("confirmWarning1");
        } catch (error: any) {
            setPickerBusy(false);
            console.error(error)
            setErrorMsg(error?.message || "שגיאה בפתיחת הדרייב");
            setStep("error");
        }
    }

    async function handleConfirmWarning1() {
        if (!selectedTank || !picked) return;

        const batch = extractBatchFromFilename(picked.name);
        if (batch === null) return;

        setStep("checking");
        setErrorMsg("");

        try {
            const tankNumber = String(selectedTank.tankNumber ?? selectedTank.id);

            const result = await checkBatchAssignment(tankNumber, batch);

            if (result.reason === "Batch not found") {
                setErrorMsg(`האצווה ${batch} לא נמצאה בכלל בתיקיית הבישולים.`);
                setStep("error");
                return;
            }
            if (result.reason === "Could not read batch sheet") {
                setErrorMsg(`לא ניתן לקרוא את גיליון האצווה ${batch}.`);
                setStep("error");
                return;
            }

            setCheckResult(result);

            const better = await findNextBatchForTank(tankNumber, batch);

            const hasTankMismatch = result.reason === "Batch belongs to a different tank";
            const hasBetterBatch = Boolean(better && better.found);

            if (hasBetterBatch) {
                setBetterBatch(better);
            }

            if (hasTankMismatch || hasBetterBatch) {
                setStep("confirmIssues");
            } else {
                setStep("chooseStatus");
            }
        } catch (error: any) {
            setErrorMsg(error?.message || "שגיאה בבדיקת האצווה");
            setStep("error");
        }
    }

    async function handleChooseStatus(option: StatusOption) {
        if (!selectedTank || !checkResult?.sheetUrl) return;

        setStep("submitting");
        setErrorMsg("");

        try {
            await assignAndRefreshTank(
                selectedTank.id,
                checkResult.sheetUrl,
                option.action,
                option.tankStatus
            );

            setStep("done");
        } catch (error: any) {
            console.error(error)
            setErrorMsg(error?.message || "שגיאה בעדכון המיכל");
            setStep("error");
        }
    }

    const displayedBatchNumber = checkResult?.batchNumber ?? checkResult?.requestedBatch;
    const hasActualTank = Boolean(checkResult?.actualTank);

    const currentStepIndex = STEP_ORDER.indexOf(
        step === "confirmIssues" ? "checking" : step
    );

    return (
        <div className="manual-batch-page">
            <div className="edit-specs-header">
                <h1 className="editSpecsHeaderH1">שיבוץ אצווה ידני במיכל</h1>
                <div className="editSpecsHeaderH2">
                    <p>
                        ⚠ פעולה זו מיועדת למקרי קצה בלבד.
                    </p>
                    <p>
                        בדרך כלל השיבוץ קורה אוטומטית ברגע
                        שנוצר טופס בישול חדש עם מספר המיכל הרשום בו, כאשר המיכל מסומן
                        כ"מחוטא".
                    </p>
                </div>
            </div>

            {step !== "select" && (
                <div className="manual-batch-stepper">
                    {STEP_ORDER.map((s, index) => (
                        <div
                            key={s}
                            className={`manual-batch-stepper-item ${index < currentStepIndex
                                    ? "done"
                                    : index === currentStepIndex
                                        ? "active"
                                        : ""
                                }`}
                        >
                            <span className="manual-batch-stepper-dot">{index + 1}</span>
                            <span className="manual-batch-stepper-label">{STEP_LABELS[s]}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="spec-card">
                <div className="spec-card-header">
                    <div>
                        <h2>בחירת מיכל</h2>
                    </div>
                </div>
                <div className="spec-fields" style={{ gridTemplateColumns: "1fr" }}>
                    <div className="spec-field">
                        {/* <label className="spec-field-label">מיכל</label> */}
                        <select
                            className="quickReportSelect switchSelect"
                            value={selectedTankId}
                            onChange={(event) => handleSelectTank(event.target.value)}
                        >
                            <option value="">בחר מיכל...</option>
                            {tanks.map((tank) => (
                                <option key={tank.id} value={tank.id}>
                                    מיכל {String(tank.tankNumber)}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {selectedTank && (
                <div className="spec-card manual-batch-compact-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>מצב נוכחי במיכל {String(selectedTank.tankNumber)}</h2>
                        </div>
                    </div>
                    <div className="spec-fields">
                        <div className="spec-field">
                            <span className="spec-field-label">אצווה נוכחית</span>
                            <span>#{selectedTank.batchNumber ?? "—"}</span>
                        </div>
                        <div className="spec-field">
                            <span className="spec-field-label">סגנון</span>
                            <span>{selectedTank.beerStyle ?? "—"}</span>
                        </div>
                        <div className="spec-field">
                            <span className="spec-field-label">תאריך בישול</span>
                            <span>{selectedTank.brewDate ?? "—"}</span>
                        </div>
                    </div>
                </div>
            )}

            {selectedTank && step === "select" && (
                <div className="spec-card manual-batch-compact-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>בחירת טופס בישול מהדרייב</h2>
                            <p>מספר האצווה ייקבע אוטומטית משם הקובץ שתבחר, ויאומת מול השרת</p>
                        </div>
                    </div>
                    <div style={{ padding: "0 16px 16px" }}>
                        <button className="btn-primary" onClick={handlePickFile} disabled={pickerBusy}>
                            {pickerBusy ? "פותח דרייב..." : "בחר טופס מהדרייב"}
                        </button>
                    </div>
                </div>
            )}

            {step === "confirmWarning1" && picked && (
                <div className="write-warning-banner critical">
                    <strong>⚠ שים לב: שיבוץ ידני של אצווה הוא פעולה חריגה מאוד.</strong>{" "}
                    <p>
                        שימוש בכלי זה עוקף את הבדיקה האוטומטית ועלול לגרום לשיבוץ שגוי אם
                        לא מוודאים היטב.
                    </p>
                    <p>
                        הקובץ שנבחר: {picked.name}
                    </p>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button className="btn-primary" onClick={handleConfirmWarning1}>
                            אני מבין, המשך בכל זאת
                        </button>
                        <button className="btn-secondary cancelBtn" onClick={resetFlow}>
                            ביטול
                        </button>
                    </div>
                </div>
            )}

            {step === "checking" && (
                <div className="manual-batch-loading">
                    <div className="manual-batch-spinner" />
                    <p>
                        <strong>בודק את האצווה מול השרת...</strong>
                    </p>
                    <p className="manual-batch-loading-sub">
                        הבדיקה סורקת את כל תיקיית טופסי הבישול (כולל תתי-תיקיות) כדי לוודא
                        שלא נעשית טעות שיבוץ — זה יכול לקחת עד כמה דקות, נא להמתין ולא
                        לסגור את המסך.
                    </p>
                </div>
            )}

            {step === "confirmIssues" && checkResult && (
                <div className="write-warning-banner critical">
                    {checkResult.reason === "Batch belongs to a different tank" && hasActualTank && (
                        <p>
                            <strong>⚠ שים לב:</strong> לפי הנתונים בטופס, אצווה #
                            {displayedBatchNumber} שייכת למיכל {checkResult.actualTank}, ולא
                            למיכל {String(selectedTank?.tankNumber)} שבחרת.
                        </p>
                    )}

                    {checkResult.reason === "Batch belongs to a different tank" && !hasActualTank && (
                        <p>
                            <span>⚠ שים לב:</span> אצווה #{displayedBatchNumber} אינה
                            משויכת כרגע לאף מיכל (שדה "מספר מיכל" ריק בטופס), ולא בטוח
                            שהיא מיועדת למיכל {String(selectedTank?.tankNumber)} שבחרת. כדאי
                            לוודא בטופס עצמו לפני שממשיכים.
                        </p>
                    )}

                    {betterBatch && betterBatch.found && (
                        <>
                            <p>
                                <span>⚠ נמצאה אצווה מתאימה יותר למיכל זה!</span> קיים טופס
                                בישול עם מספר אצווה גבוה יותר ששייך גם הוא למיכל{" "}
                                {String(selectedTank?.tankNumber)}. סביר שזו האצווה הנוכחית
                                האמיתית של המיכל.
                            </p>
                            <p>
                                <span>האצווה שבחרת:</span> #{displayedBatchNumber} —{" "}
                                {checkResult.beerStyle ?? "—"}, {checkResult.brewDate ?? "—"}
                            </p>
                            <p>
                                <span>האצווה המתאימה יותר:</span> #{betterBatch.batchNumber}{" "}
                                — {betterBatch.beerStyle ?? "—"}, {betterBatch.brewDate ?? "—"}
                            </p>
                            <p>
                                מומלץ לבדוק ולתקן את מספרי המיכל בטפסים בגוגל שיטס — המערכת
                                מתעדכנת אוטומטית מול הדרייב כל כ-10 דקות, כך שתיקון שם יגרום
                                לשיבוץ הנכון לבד, בלי צורך בפעולה ידנית.
                            </p>
                        </>
                    )}

                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button className="btn-primary" onClick={() => setStep("chooseStatus")}>
                            אני מבין, המשך עם השיבוץ הידני בכל זאת
                        </button>
                        <button className="btn-secondary cancelBtn" onClick={resetFlow}>
                            ביטול, אבדוק בגיליונות קודם
                        </button>
                    </div>
                </div>
            )}

            {step === "chooseStatus" && checkResult && (
                <div className="spec-card manual-batch-compact-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>לאיזה סטטוס לשים את המיכל?</h2>
                            <p>
                                אצווה #{displayedBatchNumber} תשובץ למיכל{" "}
                                {String(selectedTank?.tankNumber)}
                            </p>
                        </div>
                    </div>
                    <div className="manual-batch-status-grid">
                        {STATUS_OPTIONS.map((option) => (
                            <button
                                key={option.label}
                                className="manual-status-button"
                                style={{ borderColor: option.color, color: option.color }}
                                onClick={() => handleChooseStatus(option)}
                            >
                                <span className="manual-status-button-label">{option.label}</span>
                                {option.helper && (
                                    <span className="manual-status-button-helper">{option.helper}</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {step === "submitting" && (
                <div className="manual-batch-loading">
                    <div className="manual-batch-spinner" />
                    <p>
                        <strong>משבץ ומרענן נתוני מיכל...</strong>
                    </p>
                </div>
            )}

            {step === "done" && (
                <div className="edit-specs-message success">
                    המיכל שובץ בהצלחה לאצווה החדשה, וכל הנתונים (אצווה, סגנון, תאריך
                    בישול, מדידות) התעדכנו מהגיליון.
                    <div style={{ marginTop: 10 }}>
                        <button className="btn-secondary" onClick={resetFlow}>
                            שיבוץ נוסף
                        </button>
                    </div>
                </div>
            )}

            {step === "error" && (
                <div className="edit-specs-message error">
                    {errorMsg || "אירעה שגיאה"}
                    <div style={{ marginTop: 10 }}>
                        <button className="btn-secondary" onClick={resetFlow}>
                            נסה שוב
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}