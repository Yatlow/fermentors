import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Redo2, Undo2 } from "lucide-react";
import {
    startCoolerUndoRecorder,
    undoLastCoolerMove,
} from "../../SERVICES/cooler/coolerUndo";
import { redoLastCoolerMove } from "../../SERVICES/cooler/coolerRedo";
import { subscribeToCoolerHistoryCounts } from "../../SERVICES/cooler/coolerHistoryCounts";

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
    const [isMobile, setIsMobile] = useState(false);
    const [mobileHost, setMobileHost] = useState<HTMLElement | null>(null);

    useEffect(() => {
        const refreshVisibility = () => {
            const mapPage = document.querySelector(".cooler-map-page");
            setVisible(Boolean(mapPage));
            setMobileHost(
                window.matchMedia("(max-width: 768px)").matches
                    ? document.querySelector<HTMLElement>(".cooler-map-header")
                    : null
            );
        };

        refreshVisibility();
        const observer = new MutationObserver(refreshVisibility);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const mediaQuery = window.matchMedia("(max-width: 768px)");

        const syncMobileState = () => {
            setIsMobile(mediaQuery.matches);
            setMobileHost(
                mediaQuery.matches
                    ? document.querySelector<HTMLElement>(".cooler-map-header")
                    : null
            );
        };

        syncMobileState();
        mediaQuery.addEventListener("change", syncMobileState);
        return () => mediaQuery.removeEventListener("change", syncMobileState);
    }, []);

    useEffect(() => {
        if (!visible) {
            setUndoCount(0);
            setRedoCount(0);
            return;
        }

        const releaseRecorder = startCoolerUndoRecorder();
        const unsubscribeHistory = subscribeToCoolerHistoryCounts(({ undo, redo }) => {
            setUndoCount(undo);
            setRedoCount(redo);
        });
        return () => {
            unsubscribeHistory();
            releaseRecorder();
        };
    }, [visible]);

    useEffect(() => {
        if (!message) return;
        const timeout = window.setTimeout(() => setMessage(""), 3000);
        return () => window.clearTimeout(timeout);
    }, [message]);

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
        padding: isMobile ? "8px 11px" : "9px 13px",
        background: enabled ? "white" : "rgba(245,245,245,.92)",
        color: enabled ? "#155c96" : "#8a949d",
        fontWeight: 700,
        boxShadow: isMobile ? "none" : "0 4px 16px rgba(0,0,0,.14)",
        cursor: enabled && !busy ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        minHeight: 40,
    });

    const control = (
        <div
            dir="rtl"
            style={isMobile ? {
                position: "static",
                order: 99,
                width: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                gap: 6,
                pointerEvents: "none",
                marginTop: 2,
            } : {
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
                        maxWidth: isMobile ? "100%" : 320,
                        padding: "8px 11px",
                        borderRadius: 10,
                        background: "rgba(20, 30, 45, 0.92)",
                        color: "white",
                        fontSize: 13,
                        boxShadow: isMobile ? "none" : "0 4px 18px rgba(0,0,0,.18)",
                        pointerEvents: "auto",
                    }}
                >
                    {message}
                </div>
            )}

            <div
                style={{
                    display: "flex",
                    gap: 8,
                    pointerEvents: "none",
                    width: isMobile ? "100%" : undefined,
                }}
            >
                <button
                    type="button"
                    onClick={() => void performUndo()}
                    disabled={busy || undoCount <= 0}
                    title="בטל את שינוי המיקום האחרון במקרר (Ctrl+Z / Cmd+Z)"
                    style={{
                        ...buttonStyle(undoCount > 0),
                        flex: isMobile ? "1 1 0" : undefined,
                    }}
                >
                    <Undo2 size={17} strokeWidth={2.2} aria-hidden="true" />
                    <span>{busy ? "עובד…" : `בטל${undoCount > 0 ? ` (${undoCount})` : ""}`}</span>
                </button>

                <button
                    type="button"
                    onClick={() => void performRedo()}
                    disabled={busy || redoCount <= 0}
                    title="בצע מחדש (Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z)"
                    style={{
                        ...buttonStyle(redoCount > 0),
                        flex: isMobile ? "1 1 0" : undefined,
                    }}
                >
                    <Redo2 size={17} strokeWidth={2.2} aria-hidden="true" />
                    <span>{busy ? "עובד…" : `בצע מחדש${redoCount > 0 ? ` (${redoCount})` : ""}`}</span>
                </button>
            </div>
        </div>
    );

    if (isMobile && mobileHost) {
        return createPortal(control, mobileHost);
    }

    return control;
}
