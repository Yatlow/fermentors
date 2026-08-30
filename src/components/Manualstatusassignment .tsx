import { useMemo, useState } from "react";
import type { Fermentor } from "../App";
import {
    checkStatusTransition,
    assignAndRefreshTank,
    type StatusTransitionCheckResult,
} from "../SERVICES/Manualstatus ";

type Step =
    | "select"
    | "chooseTarget"
    | "confirmWarning1"
    | "checking"
    | "confirmIssues"
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

// Same 5 options as ManualBatchAssignment — these are the only
// REAL stored ACTION values. "קר" is a derived display stage
// (action=1 + temperature), not a selectable target here.
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
    "chooseTarget",
    "confirmWarning1",
    "checking",
    "submitting",
    "done",
];

const STEP_LABELS: Record<Step, string> = {
    select: "בחירה",
    chooseTarget: "סטטוס יעד",
    confirmWarning1: "אזהרה",
    checking: "בדיקה",
    confirmIssues: "בדיקה",
    submitting: "שולח",
    done: "הושלם",
    error: "שגיאה",
};

type Props = {
    brews: Fermentor[];
    isAdmin: boolean
};

export default function ManualStatusAssignment({ brews, isAdmin }: Props) {
    const [selectedTankId, setSelectedTankId] = useState<string>("");
    const [step, setStep] = useState<Step>("select");
    const [targetOption, setTargetOption] = useState<StatusOption | null>(null);
    const [checkResult, setCheckResult] = useState<StatusTransitionCheckResult | null>(null);
    const [errorMsg, setErrorMsg] = useState<string>("");
    const [showPermissionModal, setShowPermissionModal] = useState(false);

    const tanks = useMemo(
        () => brews.filter((tank) => Number(tank.tankNumber) !== 1),
        [brews]
    );

    const selectedTank = tanks.find((tank) => tank.id === selectedTankId) || null;
    const currentAction = selectedTank ? Number(selectedTank.action) : null;

    const currentOption =
        currentAction !== null
            ? STATUS_OPTIONS.find((option) => option.action === currentAction) || null
            : null;

    // Can't "transition" into the status you're already in.
    const targetOptions = STATUS_OPTIONS.filter(
        (option) => option.action !== currentAction
    );

    function resetFlow() {
        setSelectedTankId("")
        setStep("select");
        setTargetOption(null);
        setCheckResult(null);
        setErrorMsg("");
    }

    function handleSelectTank(id: string) {
        setSelectedTankId(id);
        setTargetOption(null);
        setCheckResult(null);
        setErrorMsg("");
        setStep(id ? "chooseTarget" : "select");
    }

    function handleChooseTarget(option: StatusOption) {
        setTargetOption(option);
        setCheckResult(null);
        setErrorMsg("");
        setStep("confirmWarning1");
    }

    async function handleConfirmWarning1() {
        if (!selectedTank || !targetOption) return;

        setStep("checking");
        setErrorMsg("");

        try {
            const tankNumber = String(selectedTank.tankNumber ?? selectedTank.id);

            const result = await checkStatusTransition(tankNumber, targetOption.action);

            setCheckResult(result);
            setStep("confirmIssues");

        } catch (error: any) {
            setErrorMsg(error?.message || "שגיאה בבדיקת המעבר");
            setStep("error");
        }
    }

    async function handleConfirmSubmit() {
        if (!selectedTank || !targetOption || !checkResult) return;

        if (!isAdmin) {
            setShowPermissionModal(true);
            // setError("אין לך הרשאות לשמור שינויים");
            return;
        }

        setStep("submitting");
        setErrorMsg("");

        try {
            await assignAndRefreshTank(
                selectedTank.id,
                checkResult.sheetUrl,
                targetOption.action,
                targetOption.tankStatus
            );

            setStep("done");
        } catch (error: any) {
            console.error(error);
            setErrorMsg(error?.message || "שגיאה בעדכון המיכל");
            setStep("error");
        }
    }

    const currentStepIndex = STEP_ORDER.indexOf(
        step === "confirmIssues" ? "checking" : step
    );

    return (
        <div className="manual-batch-page">
            {showPermissionModal && (
                <div
                    className="permission-modal-overlay"
                    onClick={() => {
                        setShowPermissionModal(false);
                        resetFlow();
                    }}
                >
                    <div
                        className="permission-modal"
                        onClick={(e) => e.stopPropagation()}
                        dir="rtl"
                    >
                        <div className="permission-modal-icon">
                            🔒
                        </div>

                        <h2>
                            אין הרשאה לשינוי
                        </h2>

                        <p>
                            רק מנהל מערכת יכול לשנות את הגדרות הבירה.
                        </p>

                        <button
                            className="btn-primary"
                            onClick={() => {setShowPermissionModal(false)
                                resetFlow();
                            }}
                        >
                            הבנתי
                        </button>
                    </div>
                </div>
            )}
            <div className="edit-specs-header">
                <h1 className="editSpecsHeaderH1">שינוי סטטוס מיכל ידני</h1>
                <div className="editSpecsHeaderH2 warningHeader">
                    <p>
                        ⚠ פעולה זו מיועדת למקרי קצה בלבד — לשינוי סטטוס בלי לשנות
                        את האצווה המשויכת למיכל.
                    </p>
                    <p>
                        בדרך כלל הסטטוס מתעדכן אוטומטית לפי הנתונים בגיליון הבישול.
                        אם ברצונך לשייך אצווה אחרת, יש להשתמש בכלי "שיבוץ אצווה ידני".
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

            {step === "select" && (
                <div className="spec-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>בחירת מיכל</h2>
                        </div>
                    </div>
                    <div className="spec-fields" style={{ gridTemplateColumns: "1fr" }}>
                        <div className="spec-field">
                            <select
                                className="quickReportSelect switchSelect"
                                autoComplete="off"
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
            )}

            {selectedTank && (
                <div className="spec-card manual-batch-compact-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>מצב נוכחי במיכל {String(selectedTank.tankNumber)}</h2>
                        </div>
                    </div>
                    <div className="spec-fields">
                        <div className="spec-field">
                            <span className="spec-field-label">סטטוס נוכחי</span>
                            <span>{currentOption?.label ?? "—"}</span>
                        </div>
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

            {step === "chooseTarget" && selectedTank && (
                <div className="spec-card manual-batch-compact-card">
                    <div className="spec-card-header">
                        <div>
                            <h2>לאיזה סטטוס להעביר את המיכל?</h2>
                        </div>
                    </div>
                    <div className="manual-batch-status-grid">
                        {targetOptions.map((option) => (
                            <button
                                key={option.label}
                                className="manual-status-button"
                                style={{ borderColor: option.color, color: option.color }}
                                onClick={() => handleChooseTarget(option)}
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

            {step === "confirmWarning1" && targetOption && (
                <div className="write-warning-banner critical">
                    <strong>⚠ שים לב: שינוי סטטוס ידני הוא פעולה חריגה.</strong>{" "}
                    <p>
                        שימוש בכלי זה עוקף את הבדיקה האוטומטית ועלול לגרום לשיבוש בעדכון הסטטוסים
                        האוטומטי במיכל אם נתוני הגיליון לא תואמים.
                    </p>
                    <p>
                        מעבר מבוקש: <strong>{currentOption?.label ?? "—"}</strong> ←{" "}
                        <strong>{targetOption.label}</strong>
                    </p>
                    <div className="critical-actions">
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
                        <strong>בודק את הגיליון הנוכחי של המיכל מול השרת...</strong>
                    </p>
                    <p className="manual-batch-loading-sub">
                        מוודא שאין נתונים בגיליון שעלולים להחזיר את המיכל אוטומטית
                        לסטטוס הקודם. נא להמתין.
                    </p>
                </div>
            )}

            {step === "confirmIssues" && checkResult && targetOption && (
                <div className={`write-warning-banner  ${checkResult.warnings.length ? "critical" : ""}`}>
                    {checkResult.warnings.length === 0 && (
                        <p >לא נמצאו בעיות — נתוני הגיליון תואמים למעבר המבוקש</p>
                    )}

                    {checkResult.warnings.map((warning, index) => (
                        <p key={index}>
                            <span>{warning.level === "warning" ? "⚠ " : ""}</span>
                            {warning.message}
                        </p>
                    ))}

                    <p >
                        <span>מעבר:</span> {currentOption?.label ?? "—"} ←{" "}
                        {targetOption.label} (מיכל {String(selectedTank?.tankNumber)})
                    </p>

                    <div className="critical-actions specificBtnBox">
                        <button className="btn-primary" onClick={handleConfirmSubmit}>
                            {checkResult.warnings.length ? "אני מבין, המשך בכל זאת" : "אישור וביצוע"}
                        </button>
                        <button className="btn-secondary cancelBtn" onClick={resetFlow}>
                            ביטול
                        </button>
                    </div>
                </div>
            )}

            {step === "submitting" && (
                <div className="manual-batch-loading">
                    <div className="manual-batch-spinner" />
                    <p>
                        <strong>מעדכן סטטוס מיכל...</strong>
                    </p>
                </div>
            )}

            {step === "done" && (
                <div className="edit-specs-message success">
                    סטטוס המיכל עודכן בהצלחה.
                    <div style={{ marginTop: 10 }}>
                        <button className="btn-secondary" onClick={resetFlow}>
                            שינוי נוסף
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
