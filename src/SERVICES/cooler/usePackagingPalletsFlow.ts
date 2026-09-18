import { useEffect, useMemo, useRef, useState } from "react";
import {
    submitPackagingRecord,
    createPalletsForPlan,
    computePalletQuantity,
    type PackagingType,
    type PackagingPalletPlan,
    markPackagingPalletsCompleted,
    savePackagingPalletSplits,
} from "../getAndPost/packagingMasterSheetLogger";
import {
    getDefaultPalletSplit,
    getMaxQuantityPerPallet,
    type CustomPalletSplitEntry,
} from "./Palletservice";
import type { PalletItemType } from "./Pallettypes ";
import { reserveNewPalletsForNearestShipment } from "../planning/planningShipmentReservations";

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
        if (quantity <= 0) return;
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
    const runtimesRef = useRef<JobRuntime[]>(runtimes);
    function setRuntimesSynced(updater: (prev: JobRuntime[]) => JobRuntime[]) {
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
            beerStyle: job.beerStyle,
            packagingType: job.packagingType,
            amount: job.amount,
            batchNumber: job.batchNumber,
            tankNumber: job.tankNumber,
            tankStatus: job.tankStatus,
            operationId: job.submissionId,
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

    useEffect(() => {
        if (sendStartedRef.current) return;
        sendStartedRef.current = true;
        sendPromisesRef.current = jobsRef.current.map((_, jobIndex) => sendJob(jobIndex));
        // Sending is an external side effect; it must run after commit, never during render.
        // jobsRef intentionally freezes the jobs that opened this flow.
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
            const created = await Promise.all(
                finalRuntimes.map(async (runtime, jobIndex) => {
                    if (runtime.reportedQuantity <= 0 || !runtime.palletPlan) {
                        return { ids: [] as string[], operationId: null as string | null };
                    }
                    const splits: CustomPalletSplitEntry[] = rows
                        .filter((r) => r.jobIndex === jobIndex)
                        .map((r) => ({ quantity: r.quantity, subLabel: r.subLabel }));

                    await savePackagingPalletSplits(runtime.palletPlan.operationId, splits);
                    const ids = await createPalletsForPlan(runtime.palletPlan, splits);
                    return { ids, operationId: runtime.palletPlan.operationId };
                })
            );
            const createdPalletIds = created.flatMap((item) => item.ids);

            // Reservation is part of successful packaging completion. If it
            // fails, keep the operation awaiting_pallets so retry/recovery can
            // safely run the same deterministic pallet creation and reservation
            // again without duplication.
            await reserveNewPalletsForNearestShipment(createdPalletIds);

            await Promise.all(
                created
                    .map((item) => item.operationId)
                    .filter((operationId): operationId is string => Boolean(operationId))
                    .map((operationId) => markPackagingPalletsCompleted(operationId))
            );
        } catch (err: any) {
            setStep("error");
            setSubmitError(
                err?.message ??
                "המשטחים נשמרו, אך השלמת האריזה/השיבוץ למשלוח טרם הושלמה. נסה שוב."
            );
            return;
        }

        setSubmitWarnings((current) => [
            ...current,
            ...finalRuntimes.flatMap((r) => r.sendWarnings ?? []),
        ]);
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
