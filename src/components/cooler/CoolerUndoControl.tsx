import { useCallback, useEffect, useState } from "react";
import { Redo2, Undo2 } from "lucide-react";
import {
    startCoolerUndoRecorder,
    subscribeToCoolerUndoCount,
    undoLastCoolerMove,
} from "../../SERVICES/cooler/coolerUndo";
import {
    redoLastCoolerMove,
    subscribeToCoolerRedoCount,
} from "../../SERVICES/cooler/coolerRedo";

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable ||
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select";
}

export default function CoolerUndoControl() {
    const [visible, setVisible] = useState(false);
    const [undoCount, setUndoCount] = useState(0);
    const [redoCount, setRedoCount] = useState(0);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    useEffect(() => {
        const refreshVisibility = () => {
            setVisible(Boolean(document.querySelector(".cooler-map-page")));
        };

        refreshVisibility();
        const observer = new MutationObserver(refreshVisibility);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) {
            setUndoCount(0);
            setRedoCount(0);
            return;
        }

        startCoolerUndoRecorder();
        const unsubscribeUndo = subscribeToCoolerUndoCount(setUndoCount);
        const unsubscribeRedo = subscribeToCoolerRedoCount(setRedoCount);
        return () => {
            unsubscribeUndo();
            unsubscribeRedo();
        };
    }, [visible]);

    const performUndo = useCallback(async () => {
        if (busy || undoCount <= 0) return;
        setBusy(true);
        setMessage("");
        try {
            const result = await undoLastCoolerMove();
            setMessage(`בוטל: ${result.label}`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "ביטול הפעולה נכשל");
        } finally {
            setBusy(false);
        }
    }, [busy, undoCount]);

    const performRedo = useCallback(async () => {
        if (busy || redoCount <= 0) return;
        setBusy(true);
        setMessage("");
        try {
            const result = await redoLastCoolerMove();
            setMessage(`בוצע מחדש: ${result.label}`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "ביצוע הפעולה מחדש נכשל");
        } finally {
            setBusy(false);
        }
    }, [busy, redoCount]);

    useEffect(() => {
        if (!visible) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || isEditableTarget(event.target)) return;

            const key = event.key.toLowerCase();
            const wantsUndo = key === "z" && !event.shiftKey;
            const wantsRedo = key === "y" || (key === "z" && event.shiftKey);

            if (wantsUndo && !busy && undoCount > 0) {
                event.preventDefault();
                void performUndo();
                return;
            }

            if (wantsRedo && !busy && redoCount > 0) {
                event.preventDefault();
                void performRedo();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [visible, busy, undoCount, redoCount, performUndo, performRedo]);

    if (!visible) return null;

    const buttonStyle = (enabled: boolean) => ({
        pointerEvents: "auto" as const,
        border: "1px solid rgba(20, 90, 150, .25)",
        borderRadius: 12,
        padding: "9px 13px",
        background: enabled ? "white" : "rgba(245,245,245,.92)",
        color: enabled ? "#155c96" : "#8a949d",
        fontWeight: 700,
        boxShadow: "0 4px 16px rgba(0,0,0,.14)",
        cursor: enabled && !busy ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
    });

    return (
        <div
            dir="rtl"
            style={{
                position: "fixed",
                left: 14,
                bottom: "calc(14px + env(safe-area-inset-bottom))",
                zIndex: 10000,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
                pointerEvents: "none",
            }}
        >
            {message && (
                <div
                    role="status"
                    style={{
                        maxWidth: 320,
                        padding: "8px 11px",
                        borderRadius: 10,
                        background: "rgba(20, 30, 45, 0.92)",
                        color: "white",
                        fontSize: 13,
                        boxShadow: "0 4px 18px rgba(0,0,0,.18)",
                        pointerEvents: "auto",
                    }}
                >
                    {message}
                </div>
            )}

            <div style={{ display: "flex", gap: 8, pointerEvents: "none" }}>
                <button
                    type="button"
                    onClick={() => void performUndo()}
                    disabled={busy || undoCount <= 0}
                    title="בטל את שינוי המיקום האחרון במקרר (Ctrl+Z / Cmd+Z)"
                    style={buttonStyle(undoCount > 0)}
                >
                    <Undo2 size={17} strokeWidth={2.2} aria-hidden="true" />
                    <span>{busy ? "עובד…" : `בטל${undoCount > 0 ? ` (${undoCount})` : ""}`}</span>
                </button>

                <button
                    type="button"
                    onClick={() => void performRedo()}
                    disabled={busy || redoCount <= 0}
                    title="בצע מחדש (Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z)"
                    style={buttonStyle(redoCount > 0)}
                >
                    <Redo2 size={17} strokeWidth={2.2} aria-hidden="true" />
                    <span>{busy ? "עובד…" : `בצע מחדש${redoCount > 0 ? ` (${redoCount})` : ""}`}</span>
                </button>
            </div>
        </div>
    );
}
