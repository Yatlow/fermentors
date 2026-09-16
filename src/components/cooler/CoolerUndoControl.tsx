import { useCallback, useEffect, useState } from "react";
import {
    subscribeToCoolerUndoCount,
    undoLastCoolerMove,
} from "../../SERVICES/cooler/coolerUndo";

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

    useEffect(() => subscribeToCoolerUndoCount(setUndoCount), []);

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

    useEffect(() => {
        if (!visible) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
            if (event.shiftKey || event.altKey || isEditableTarget(event.target)) return;
            if (busy || undoCount <= 0) return;

            event.preventDefault();
            void performUndo();
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [visible, busy, undoCount, performUndo]);

    if (!visible) return null;

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

            <button
                type="button"
                onClick={() => void performUndo()}
                disabled={busy || undoCount <= 0}
                title="בטל את שינוי המיקום האחרון במקרר (Ctrl+Z / Cmd+Z)"
                style={{
                    pointerEvents: "auto",
                    border: "1px solid rgba(20, 90, 150, .25)",
                    borderRadius: 12,
                    padding: "9px 13px",
                    background: undoCount > 0 ? "white" : "rgba(245,245,245,.92)",
                    color: undoCount > 0 ? "#155c96" : "#8a949d",
                    fontWeight: 700,
                    boxShadow: "0 4px 16px rgba(0,0,0,.14)",
                    cursor: undoCount > 0 && !busy ? "pointer" : "default",
                }}
            >
                {busy ? "מבטל…" : `↶ בטל פעולה${undoCount > 0 ? ` (${undoCount})` : ""}`}
            </button>
        </div>
    );
}
