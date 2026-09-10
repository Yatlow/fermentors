import { useMemo, useRef, useState } from "react";
import {
    submitPackagingRecord,
    createPalletsForPlan,
    computePalletQuantity,
    type PackagingType,
    type PackagingPalletPlan,
} from "../getAndPost/packagingMasterSheetLogger";
import {
    getDefaultPalletSplit,
    getMaxQuantityPerPallet,
    type CustomPalletSplitEntry,
} from "./Palletservice";
import type { PalletItemType } from "./Pallettypes ";

export type PackagingJobInput = {
    /** מזהה קבוע לדיווח; אותו מזהה משמש גם בניסיון חוזר */
    submissionId: string;
    tankId: string;
    tankNumber: string | number;
    beerStyle: string | undefined | null;
    packagingType: PackagingType;
    amount: number;
    batchNumber: string | number | undefined | null;
    tankStatus: boolean;
};

export type PendingPalletRow = {
    id: string;
    jobIndex: number;
    itemType: PalletItemType;
    quantity: number;
    subLabel: string | null;
};

type JobRuntime = {
    job: PackagingJobInput;
    itemType: PalletItemType;
    /** כמות שדווחה בפועל (חביות/ארגזים) - מחושבת סינכרונית, לא תלויה ברשת */
    reportedQuantity: number;
    sendStatus: "pending" | "done" | "error";
    palletPlan: PackagingPalletPlan | null;
    sendError?: string;
    sendWarnings?: string[];
};

export type FlowStep = "review" | "submitting" | "done" | "error";
export type SubmittingPhase = "waitingForSend" | "creatingPallets" | null;
/** מצב "שלב 1" - כתיבת הנתונים ברקע. רץ מקביל לשלב review, מוצג בנפרד ב-stepper. */
export type SendPhase = "pending" | "done" | "error";

let rowIdCounter = 0;
function nextRowId() {
    rowIdCounter += 1;
    return `row_${rowIdCounter}`;
}

function itemTypeFor(packagingType: PackagingType): PalletItemType {
    return packagingType === "kegs" ? "kegs" : "crates";
}

function buildInitialRows(jobs: PackagingJobInput[]): PendingPalletRow[] {
    const rows: PendingPalletRow[] = [];
    jobs.forEach((job, jobIndex) => {
        const itemType = itemTypeFor(job.packagingType);
        const quantity = computePalletQuantity(job.packagingType, job.amount);
        if (quantity <= 0) return; // פחות מארגז/יחידה שלמה - אין מה לחלק
        getDefaultPalletSplit(itemType, quantity).forEach((entry) => {
            rows.push({
                id: nextRowId(),
                jobIndex,
                itemType,
                quantity: entry.quantity,
                subLabel: entry.subLabel ?? null,
            });
        });
    });
    return rows;
}

export function usePackagingPalletsFlow(jobs: PackagingJobInput[]) {
    // נלכדים פעם אחת - גם אם ההורה מעביר מערך חדש בכל רינדור
    const jobsRef = useRef(jobs);

    const [runtimes, setRuntimes] = useState<JobRuntime[]>(() =>
        jobsRef.current.map((job) => ({
            job,
            itemType: itemTypeFor(job.packagingType),
            reportedQuantity: computePalletQuantity(job.packagingType, job.amount),
            sendStatus: "pending",
            palletPlan: null,
        }))
    );
    // מקור אמת סינכרוני לקריאה בתוך confirm() בלי לחכות לרינדור מחדש
    const runtimesRef = useRef<JobRuntime[]>(runtimes);
    function setRuntimesSynced(updater: (prev: JobRuntime[]) => JobRuntime[]) {
        // חשוב לעדכן את ה-ref לפני שה-Promise של sendJob מסתיים.
        // setState יכול להידחות על ידי React; במקרה כזה confirm() היה רואה
        // palletPlan=null, מדלג על היצירה ובכל זאת מציג הצלחה.
        const next = updater(runtimesRef.current);
        runtimesRef.current = next;
        setRuntimes(next);
    }

    const [rows, setRows] = useState<PendingPalletRow[]>(() => buildInitialRows(jobsRef.current));

    const [step, setStep] = useState<FlowStep>("review");
    const [submittingPhase, setSubmittingPhase] = useState<SubmittingPhase>(null);
    const [submitError, setSubmitError] = useState<string>("");
    const [submitWarnings, setSubmitWarnings] = useState<string[]>([]);

    const sendPromisesRef = useRef<Promise<void>[]>([]);
    const sendStartedRef = useRef(false);

    function sendJob(jobIndex: number): Promise<void> {
        const job = jobsRef.current[jobIndex];
        const promise = submitPackagingRecord({
            // submissionId: job.submissionId,
            // tankId: job.tankId,
            beerStyle: job.beerStyle,
            packagingType: job.packagingType,
            amount: job.amount,
            batchNumber: job.batchNumber,
            tankNumber: job.tankNumber,
            tankStatus: job.tankStatus,
        })
            .then((result) => {
                setRuntimesSynced((prev) => {
                    const next = [...prev];
                    next[jobIndex] = {
                        ...next[jobIndex],
                        sendStatus: result.success ? "done" : "error",
                        palletPlan: result.palletPlan,
                        sendError: result.error,
                        sendWarnings: result.warnings,
                    };
                    return next;
                });
            })
            .catch((err: any) => {
                setRuntimesSynced((prev) => {
                    const next = [...prev];
                    next[jobIndex] = {
                        ...next[jobIndex],
                        sendStatus: "error",
                        sendError: err?.message ?? "שגיאה בשליחת הנתונים",
                    };
                    return next;
                });
            });
        return promise;
    }

    // שלב 1 מהאפיון: מתחילים לשלוח ברקע מיד עם הטעינה, בלי לחכות לזה בתצוגה.
    useMemo(() => {
        if (sendStartedRef.current) return;
        sendStartedRef.current = true;
        sendPromisesRef.current = jobsRef.current.map((_, jobIndex) => sendJob(jobIndex));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function retryJobSend(jobIndex: number) {
        setRuntimesSynced((prev) => {
            const next = [...prev];
            next[jobIndex] = { ...next[jobIndex], sendStatus: "pending", sendError: undefined };
            return next;
        });
        sendPromisesRef.current[jobIndex] = sendJob(jobIndex);
    }

    function updateRowQuantity(id: string, quantity: number) {
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, quantity } : r)));
    }
    function updateRowSubLabel(id: string, subLabel: string) {
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, subLabel: subLabel || null } : r)));
    }
    function removeRow(id: string) {
        setRows((prev) => prev.filter((r) => r.id !== id));
    }
    function splitRow(id: string) {
        setRows((prev) => {
            const idx = prev.findIndex((r) => r.id === id);
            if (idx === -1 || prev[idx].quantity <= 1) return prev;
            const row = prev[idx];
            const half = Math.floor(row.quantity / 2);
            const rest = row.quantity - half;
            const next = [...prev];
            next[idx] = { ...row, quantity: rest };
            next.splice(idx + 1, 0, { ...row, id: nextRowId(), quantity: half, subLabel: null });
            return next;
        });
    }
    function addRow(jobIndex: number) {
        const runtime = runtimes[jobIndex];
        if (!runtime) return;
        setRows((prev) => [
            ...prev,
            { id: nextRowId(), jobIndex, itemType: runtime.itemType, quantity: 0, subLabel: null },
        ]);
    }

    const validation = useMemo(() => {
        return runtimes.map((runtime, jobIndex) => {
            const jobRows = rows.filter((r) => r.jobIndex === jobIndex);
            const sum = jobRows.reduce((acc, r) => acc + (Number(r.quantity) || 0), 0);
            const max = getMaxQuantityPerPallet(runtime.itemType);
            const overLimitRow = jobRows.find((r) => r.quantity > max)?.id ?? null;
            const hasZero = jobRows.some((r) => r.quantity <= 0);
            const ok = runtime.reportedQuantity <= 0 || (sum === runtime.reportedQuantity && !overLimitRow && !hasZero);
            return { jobIndex, ok, sum, expected: runtime.reportedQuantity, overLimitRow };
        });
    }, [rows, runtimes]);

    const isValid = validation.every((v) => v.ok);

    // "שלב 1" בסטפר - כתיבת הנתונים למאסטר-שיט. רץ ברקע כל עוד המשתמש בשלב review.
    // pending כל עוד יש עבודה רלוונטית (reportedQuantity > 0) שעדיין לא נשלחה,
    // error אם משהו נכשל, done כשהכל נשלח בהצלחה (או שאין בכלל מה לשלוח).
    const sendPhase: SendPhase = useMemo(() => {
        const relevant = runtimes.filter((r) => r.reportedQuantity > 0);
        if (relevant.length === 0) return "done";
        if (relevant.some((r) => r.sendStatus === "error")) return "error";
        if (relevant.some((r) => r.sendStatus === "pending")) return "pending";
        return "done";
    }, [runtimes]);

    async function confirm() {
        if (!isValid || (step !== "review" && step !== "error")) return;

        const stillSending = runtimesRef.current.some(
            (r) => r.reportedQuantity > 0 && r.sendStatus === "pending"
        );
        setStep("submitting");
        setSubmittingPhase(stillSending ? "waitingForSend" : "creatingPallets");
        setSubmitError("");
        setSubmitWarnings([]);

        await Promise.allSettled(sendPromisesRef.current);

        const finalRuntimes = runtimesRef.current;
        const failedSend = finalRuntimes.find((r) => r.reportedQuantity > 0 && r.sendStatus === "error");
        if (failedSend) {
            setStep("error");
            setSubmitError(failedSend.sendError ?? "שגיאה בשליחת הנתונים");
            return;
        }

        const missingPlan = finalRuntimes.find(
            (r) => r.reportedQuantity > 0 && !r.palletPlan
        );
        if (missingPlan) {
            setStep("error");
            setSubmitError(
                `לא התקבלה תוכנית משטחים למיכל ${String(missingPlan.job.tankNumber)}. המשטחים לא נוצרו.`
            );
            return;
        }

        setSubmittingPhase("creatingPallets");

        try {
            await Promise.all(
                finalRuntimes.map((runtime, jobIndex) => {
                    if (runtime.reportedQuantity <= 0 || !runtime.palletPlan) return Promise.resolve();
                    const splits: CustomPalletSplitEntry[] = rows
                        .filter((r) => r.jobIndex === jobIndex)
                        .map((r) => ({ quantity: r.quantity, subLabel: r.subLabel }));
                    return createPalletsForPlan(runtime.palletPlan, splits).then(() => undefined);
                })
            );
        } catch (err: any) {
            setStep("error");
            setSubmitError(err?.message ?? "שגיאה ביצירת המשטחים במפת המקרר");
            return;
        }

        setSubmitWarnings(finalRuntimes.flatMap((r) => r.sendWarnings ?? []));
        setStep("done");
    }

    return {
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
    };
}
