import { useEffect, useRef, useState } from "react";
import {
    searchBrewSheets,
    extractFileIdFromUrl,
    getFileById,
    type PickedFile,
} from "../SERVICES/googleDrivePicker";

type Props = {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (file: PickedFile) => void;
};

export default function DriveFileSearchModal({ isOpen, onClose, onSelect }: Props) {
    const [term, setTerm] = useState("");
    const [files, setFiles] = useState<PickedFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");

    const [urlInput, setUrlInput] = useState("");
    const [urlLoading, setUrlLoading] = useState(false);
    const [urlError, setUrlError] = useState("");

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        setTerm("");
        setErrorMsg("");
        setUrlInput("");
        setUrlError("");
        runSearch("");
        setTimeout(() => inputRef.current?.focus(), 50);
    }, [isOpen]);

    function handleChange(value: string) {
        setTerm(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => runSearch(value), 350);
    }

    async function runSearch(value: string) {
        setLoading(true);
        setErrorMsg("");
        try {
            const results = await searchBrewSheets(value);
            setFiles(results);
        } catch (error: any) {
            setErrorMsg(error?.message || "שגיאה בחיפוש בדרייב");
        } finally {
            setLoading(false);
        }
    }

    async function handleUrlSubmit() {
        const fileId = extractFileIdFromUrl(urlInput);
        if (!fileId) {
            setUrlError("לא זוהה מזהה קובץ תקין בקישור שהודבק");
            return;
        }

        setUrlLoading(true);
        setUrlError("");
        try {
            const file = await getFileById(fileId);
            onSelect(file);
        } catch (error: any) {
            setUrlError(error?.message || "שגיאה באיתור הקובץ");
        } finally {
            setUrlLoading(false);
        }
    }

    if (!isOpen) return null;

    return (
        <div className="batch-chart-overlay" onClick={onClose}>
            <div className="batch-chart-modal" onClick={(e) => e.stopPropagation()}>
                <div className="batch-chart-header">
                    <div >
                        <div className="batch-chart-title">בחירת טופס בישול</div>
                        <div className="batch-chart-subtitle">
                            חפש/י לפי מספר אצווה, או הדבק/י קישור ישירות
                        </div>
                    </div>
                    <button className="batch-chart-close" onClick={onClose}>
                        ✕
                    </button>
                </div>

                {/* הדבקת URL ישיר */}
                <div className="drive-url-row batch-chart-title-box">
                    <input
                        type="text"
                        className="drive-search-input"
                        placeholder="הדבק/י קישור לגיליון (docs.google.com/spreadsheets/...)"
                        value={urlInput}
                        onChange={(e) => {
                            setUrlInput(e.target.value);
                            setUrlError("");
                        }}
                        autoComplete="off"
                    />
                    <button
                        className="btn-primary drive-url-submit"
                        onClick={handleUrlSubmit}
                        disabled={!urlInput.trim() || urlLoading}
                    >
                        {urlLoading ? "בודק..." : "אישור"}
                    </button>
                </div>
                {urlError && (
                    <div className="measurementError" style={{ marginBottom: 10 }}>
                        {urlError}
                    </div>
                )}

                <div className="drive-search-divider">
                    <span>או בחר/י מהרשימה</span>
                </div>

                <input
                    ref={inputRef}
                    type="text"
                    className="drive-search-input"
                    placeholder="חיפוש לפי מספר אצווה, לדוגמה: 1578"
                    value={term}
                    onChange={(e) => handleChange(e.target.value)}
                    autoComplete="off"
                />

                {loading && <div className="batch-chart-status">טוען קבצים...</div>}

                {!loading && errorMsg && (
                    <div className="measurementError" style={{ marginTop: 10 }}>
                        {errorMsg}
                    </div>
                )}

                {!loading && !errorMsg && files.length === 0 && (
                    <div className="measurementEmpty" style={{ marginTop: 10 }}>
                        לא נמצאו קבצים תואמים
                    </div>
                )}

                {!loading && !errorMsg && files.length > 0 && (
                    <ul className="drive-search-list">
                        {files.map((file) => (
                            <li
                                key={file.id}
                                className="drive-search-item"
                                onClick={() => onSelect(file)}
                            >
                                {file.name}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}