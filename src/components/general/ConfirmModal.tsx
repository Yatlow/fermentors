// ConfirmModal.tsx
import { createPortal } from "react-dom";
export default function ConfirmModal({
    title, message, confirmLabel = "אישור", cancelLabel = "ביטול", danger, onConfirm, onCancel,
}: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return createPortal(
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-box confirm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} dir="rtl">
                <h3>{title}</h3>
                <p>{message}</p>
                <div className="modal-actions-primary">
                    <button className={danger ? "modal-danger-btn" : "modal-save-btn"} onClick={onConfirm}>{confirmLabel}</button>
                    <button className="modal-cancel-btn" onClick={onCancel}>{cancelLabel}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}