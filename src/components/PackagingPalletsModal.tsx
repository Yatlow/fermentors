import BeerLoader from "./Loading";
import { usePackagingPalletsFlow, type PackagingJobInput } from "../SERVICES/usePackagingPalletsFlow";

type Props = {
    jobs: PackagingJobInput[];
    onFinished: () => void;
};

const STEP_ORDER = ["review", "submitting", "done"] as const;
const STEP_LABELS: Record<string, string> = {
    review: "עריכת משטחים",
    submitting: "יצירת משטחים",
    done: "הושלם",
};

export default function PackagingPalletsModal({ jobs, onFinished }: Props) {
    const {
        step,
        runtimes,
        rows,
        validation,
        isValid,
        submittingPhase,
        submitError,
        submitWarnings,
        sendPhase,
        updateRowQuantity,
        updateRowSubLabel,
        removeRow,
        splitRow,
        addRow,
        retryJobSend,
        confirm,
    } = usePackagingPalletsFlow(jobs);

    const currentStepIndex = STEP_ORDER.indexOf(step === "error" ? "submitting" : step);

    return (
        // בכוונה בלי onClick לסגירה על הרקע - פעולה קריטית, לא רוצים סגירה בטעות
        <div className="modal-overlay">
            <div className="modal-box">
                <div className="modal-box-scroll">
                    <h3 className="packagingPalletsTitle">אישור אריזה ומשטחים</h3>
                    <p className="packagingPalletsSubtitle">
                        כל שורה מייצגת <strong>משטח נפרד</strong> שייווצר במפת המקרר.
                        אפשר לערוך את הכמות, להוסיף תווית משנה, לפצל משטח לשניים או למחוק - לפני האישור הסופי.
                    </p>

                    <div className="manual-batch-stepper">
                        <div
                            className={`manual-batch-stepper-item ${sendPhase === "done"
                                ? "done"
                                : sendPhase === "error"
                                    ? "error"
                                    : "active sending"
                                }`}
                        >
                            <span className="manual-batch-stepper-dot">1</span>
                            <span className="manual-batch-stepper-label">שליחת נתונים</span>
                        </div>
                        {STEP_ORDER.map((s, index) => (
                            <div
                                key={s}
                                className={`manual-batch-stepper-item ${index < currentStepIndex ? "done" : index === currentStepIndex ? "active" : ""
                                    }`}
                            >
                                <span className="manual-batch-stepper-dot">{index + 2}</span>
                                <span className="manual-batch-stepper-label">{STEP_LABELS[s]}</span>
                            </div>
                        ))}
                    </div>

                    {step === "review" && (
                        <div className="packagingPalletsReview">
                            {runtimes.map((runtime, jobIndex) => {
                                const unit = runtime.itemType === "kegs" ? "חביות" : "ארגזים";
                                const jobRows = rows.filter((r) => r.jobIndex === jobIndex);
                                const jobValidation = validation.find((v) => v.jobIndex === jobIndex);

                                if (runtime.reportedQuantity <= 0) {
                                    return (
                                        <div className="spec-card manual-batch-compact-card" key={jobIndex}>
                                            <div className="spec-card-header">
                                                <h2>מיכל {String(runtime.job.tankNumber)} - {runtime.job.beerStyle ?? "—"}</h2>
                                            </div>
                                            <p className="manual-batch-loading-sub packagingPalletsEmptyNote">
                                                פחות מ{unit === "חביות" ? "יחידה" : "ארגז"} שלם - לא ייווצרו משטחים עבור דיווח זה.
                                            </p>
                                        </div>
                                    );
                                }

                                return (
                                    <div className="spec-card manual-batch-compact-card" key={jobIndex}>
                                        <div className="spec-card-header">
                                            <div>
                                                <h2>מיכל {String(runtime.job.tankNumber)} - {runtime.job.beerStyle ?? "—"}</h2>
                                                <p>
                                                    {runtime.sendStatus === "pending" && (
                                                        <span className="packagingPalletsSendingIndicator">
                                                            <BeerLoader message="שולח נתונים ברקע..." size="small" />
                                                        </span>
                                                    )}
                                                    {runtime.sendStatus === "done" && "הנתונים נשלחו בהצלחה"}
                                                    {runtime.sendStatus === "error" && (
                                                        <span className="status-error">
                                                            שגיאה בשליחה: {runtime.sendError}{" "}
                                                            <button className="btn-secondary" type="button" onClick={() => retryJobSend(jobIndex)}>
                                                                נסה שוב
                                                            </button>
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>

                                        <p className="packagingPalletsRowsHint">
                                            {jobRows.length} משטחים עבור המיכל הזה - כמות, תווית ופעולות לכל משטח בשורה שלו:
                                        </p>
                                        <p className={`packagingPalletsJobTotal ${jobValidation?.ok ? "status-sent" : "status-error"}`}>
                                            סה"כ: {jobValidation?.sum ?? 0} מתוך {runtime.reportedQuantity} {unit} באריזה זו
                                        </p>

                                        <div className="packagingPalletsRows">
                                            {jobRows.map((row, rowIndex) => (
                                                <div className="packagingPalletRow" key={row.id}>
                                                    <span className="packagingPalletRowIndex">{rowIndex + 1}</span>
                                                    <div className="packagingPalletRowQty">
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            value={row.quantity}
                                                            onChange={(e) => updateRowQuantity(row.id, Number(e.target.value) || 0)}
                                                        />
                                                        <span>{unit}</span>
                                                    </div>
                                                    <input
                                                        type="text"
                                                        className="packagingPalletRowLabel"
                                                        placeholder="תווית משנה (אופציונלי)"
                                                        value={row.subLabel ?? ""}
                                                        onChange={(e) => updateRowSubLabel(row.id, e.target.value)}
                                                    />
                                                    <div className="packagingPalletRowActions">
                                                        <button
                                                            type="button"
                                                            className="btn-secondary"
                                                            onClick={() => splitRow(row.id)}
                                                            disabled={row.quantity <= 1}
                                                        >
                                                            פצל
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn-secondary cancelBtn"
                                                            onClick={() => removeRow(row.id)}
                                                            disabled={jobRows.length <= 1}
                                                        >
                                                            מחק
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="packagingPalletsAddRow">
                                            <button type="button" className="btn-secondary" onClick={() => addRow(jobIndex)}>
                                                הוסף משטח
                                            </button>
                                        </div>
                                        <p className={`packagingPalletsJobTotal ${jobValidation?.ok ? "status-sent" : "status-error"}`}>
                                            סה"כ: {jobValidation?.sum ?? 0} מתוך {runtime.reportedQuantity} {unit} באריזה זו
                                        </p>

                                    </div>
                                );
                            })}

                            <div className="packagingPalletsSubmitRow">
                                <button className="btn-primary packagingPalletsSubmitBtn" type="button" disabled={!isValid} onClick={confirm}>
                                    אישור ויצירת משטחים
                                </button>
                            </div>
                        </div>
                    )}

                    {step === "submitting" && (
                        <div className="manual-batch-loading">
                            <BeerLoader message="" size="medium" />
                            <p>
                                <strong>
                                    {submittingPhase === "waitingForSend"
                                        ? "ממתין לסיום שליחת הנתונים..."
                                        : "יוצר משטחים במפת המקרר..."}
                                </strong>
                            </p>
                        </div>
                    )}

                    {step === "done" && (
                        <div className="edit-specs-message success">
                            המשטחים נוצרו בהצלחה ונוספו למפת המקרר.
                            {submitWarnings.length > 0 && (
                                <ul>
                                    {submitWarnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                            )}
                            <div style={{ marginTop: 10 }}>
                                <button type="button" className="btn-primary" onClick={onFinished}>
                                    סגירה
                                </button>
                            </div>
                        </div>
                    )}

                    {step === "error" && (
                        <div className="edit-specs-message error">
                            {submitError || "אירעה שגיאה ביצירת המשטחים"}
                            <div style={{ marginTop: 10 }}>
                                <button type="button" className="btn-secondary" onClick={confirm}>
                                    נסה שוב
                                </button>
                                <button type="button" className="btn-secondary cancelBtn" onClick={onFinished}>
                                    סגור בכל זאת
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}