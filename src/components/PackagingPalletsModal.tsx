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

                    <div className="manual-batch-stepper">
                        {STEP_ORDER.map((s, index) => (
                            <div
                                key={s}
                                className={`manual-batch-stepper-item ${
                                    index < currentStepIndex ? "done" : index === currentStepIndex ? "active" : ""
                                }`}
                            >
                                <span className="manual-batch-stepper-dot">{index + 1}</span>
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
                                                    {runtime.sendStatus === "pending" && "שולח נתונים ברקע..."}
                                                    {runtime.sendStatus === "done" && "הנתונים נשלחו בהצלחה"}
                                                    {runtime.sendStatus === "error" && (
                                                        <span className="status-error">
                                                            שגיאה בשליחה: {runtime.sendError}{" "}
                                                            <button className="btn-secondary" onClick={() => retryJobSend(jobIndex)}>
                                                                נסה שוב
                                                            </button>
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="packagingPalletsRows">
                                            {jobRows.map((row) => (
                                                <div className="packagingPalletRow" key={row.id}>
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
                                                            className="btn-secondary"
                                                            onClick={() => splitRow(row.id)}
                                                            disabled={row.quantity <= 1}
                                                        >
                                                            פצל
                                                        </button>
                                                        <button
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
                                            <button className="btn-secondary" onClick={() => addRow(jobIndex)}>
                                                הוסף משטח
                                            </button>
                                        </div>

                                        <p className={`packagingPalletsJobTotal ${jobValidation?.ok ? "status-sent" : "status-error"}`}>
                                            סה"כ: {jobValidation?.sum ?? 0} מתוך {runtime.reportedQuantity} {unit} נדרשים
                                        </p>
                                    </div>
                                );
                            })}

                            <div className="packagingPalletsSubmitRow">
                                <button className="btn-primary packagingPalletsSubmitBtn" disabled={!isValid} onClick={confirm}>
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
                                <button className="btn-primary" onClick={onFinished}>
                                    סגירה
                                </button>
                            </div>
                        </div>
                    )}

                    {step === "error" && (
                        <div className="edit-specs-message error">
                            {submitError || "אירעה שגיאה ביצירת המשטחים"}
                            <div style={{ marginTop: 10 }}>
                                <button className="btn-secondary" onClick={confirm}>
                                    נסה שוב
                                </button>
                                <button className="btn-secondary cancelBtn" onClick={onFinished}>
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