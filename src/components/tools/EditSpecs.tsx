import BeerLoader from "../general/Loading";
import { useEffect, useState } from "react";
import { doc, updateDoc } from "firebase/firestore";

import { db } from "../../firebase";
import {
    getSpecsFromFb,
    type SpecChart,
} from "../../SERVICES/getAndPost/getSpecsFromFb";

const fieldTranslations: Record<string, string> = {
    bottleExpDat: "תוקף (מספר חודשים)",
    kegBBE: "חבית",
    tolorances: "הגדרות כלליות לחישוב המלצות",
    hops: "aa%",
    citra_aa: "סיטרה",
    cascade_aa: "קסקייד",
    talos_aa: "טאלוס",

    carbonation: "גיזוז תקין",
    dryHopMinPlato: "פלאטו שמתחתיו מומלץ על דרייהופ",
    dycitalRestMinPlato: "פלאטו שמתחתיו מומלץ על מנוחת דיאצטיל",
    pressure: " לחץ רצוי למיכל חם- אחרי סגירה",
    shutTankMinPlato: "פלאטו שמתחתיו מומלץ על סגירת מיכל",
    yeastDropMinPlato: "פלאטו שמתחתיו מומלץ על הורדת שמרים",
    yeastDropMinPlatoLager: "פלאטו שמתחתיו מומלץ על הורדת שמרים – לאגר",

    ipa: "IPA",
    הופי: "הופי",
    חיטה: "חיטה",
    לאגר: "לאגר",
    סטאוט: "סטאוט",
    פייל: "פייל",
    other: "אחר",
};

function normalizeSpecKey(value: string): string {
    return value.trim().toLowerCase();
}

function translateSpecKey(value: string): string {
    const normalized = normalizeSpecKey(value);
    return fieldTranslations[normalized] ?? fieldTranslations[value] ?? value.trim();
}

export default function EditSpecs({ isAdmin }: { isAdmin: boolean }) {
    const [specs, setSpecs] = useState<SpecChart>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [showPermissionModal, setShowPermissionModal] = useState(false);

    useEffect(() => {
        const loadSpecs = async () => {
            try {
                setLoading(true);
                setError("");
                setSpecs(await getSpecsFromFb());
            } catch (err) {
                console.error("Error loading specs:", err);
                setError("אירעה שגיאה בטעינת הנתונים");
            } finally {
                setLoading(false);
            }
        };

        loadSpecs();
    }, []);

    const handleChange = (
        documentId: string,
        fieldName: string,
        value: string
    ) => {
        setSpecs((prev) => ({
            ...prev,
            [documentId]: {
                ...prev[documentId],
                [fieldName]: Number(value),
            },
        }));
        setSuccess("");
    };

    const handleSave = async () => {
        if (!isAdmin) {
            setShowPermissionModal(true);
            return;
        }

        try {
            setSaving(true);
            setError("");
            setSuccess("");

            await Promise.all(
                Object.entries(specs).map(async ([documentId, values]) => {
                    await updateDoc(doc(db, "specs", documentId), values);
                })
            );

            setSuccess("השינויים נשמרו בהצלחה ✓");
        } catch (err) {
            console.error("Error saving specs:", err);
            setError("אירעה שגיאה בשמירת הנתונים");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="edit-specs-page" dir="rtl">
                <div className="edit-specs-status">
                    <BeerLoader message="טוען נתונים..." size="medium" />
                </div>
            </div>
        );
    }

    return (
        <div className="edit-specs-page" dir="rtl">
            {showPermissionModal && (
                <div
                    className="permission-modal-overlay"
                    onClick={() => setShowPermissionModal(false)}
                >
                    <div
                        className="permission-modal"
                        onClick={(e) => e.stopPropagation()}
                        dir="rtl"
                    >
                        <div className="permission-modal-icon">🔒</div>
                        <h2>אין הרשאה לשינוי</h2>
                        <p>רק מנהל מערכת יכול לשנות את הגדרות הבירה.</p>
                        <button
                            className="btn-primary"
                            onClick={() => setShowPermissionModal(false)}
                        >
                            הבנתי
                        </button>
                    </div>
                </div>
            )}

            <div className="edit-specs-header">
                <div>
                    <p className="editSpecsHeaderH1">עריכת הגדרות לבירה</p>
                    <p className="editSpecsHeaderH2">
                        שינוי הגדרות לחישוב המלצות ומתן תוקף בעת אריזה
                    </p>
                </div>
            </div>

            {error && <div className="edit-specs-message error">{error}</div>}
            {success && <div className="edit-specs-message success">{success}</div>}

            <div className="specs-list">
                {Object.entries(specs).map(([documentId, values]) => (
                    <section className="spec-card" key={documentId}>
                        <div className="spec-card-header">
                            <div>
                                <h2>{translateSpecKey(documentId)}</h2>
                            </div>
                        </div>

                        <div className="spec-fields">
                            {Object.entries(values)
                                .sort(([fieldA], [fieldB]) => {
                                    const order = [
                                        "ipa",
                                        "הופי",
                                        "חיטה",
                                        "לאגר",
                                        "סטאוט",
                                        "פייל",
                                        "other",
                                        "kegBBE",
                                    ];
                                    const indexA = order.indexOf(fieldA);
                                    const indexB = order.indexOf(fieldB);
                                    return (
                                        (indexA === -1 ? 999 : indexA) -
                                        (indexB === -1 ? 999 : indexB)
                                    );
                                })
                                .map(([fieldName, value]) => (
                                    <label className="spec-field" key={fieldName}>
                                        <span className="spec-field-label">
                                            {normalizeSpecKey(documentId) === "bottleexpdat"
                                                ? normalizeSpecKey(fieldName) === "kegbbe"
                                                    ? translateSpecKey(fieldName)
                                                    : `בקבוק ${translateSpecKey(fieldName)}`
                                                : normalizeSpecKey(fieldName) === "carbonation"
                                                    ? "סף סטייה לתקינות גיזוז"
                                                    : normalizeSpecKey(fieldName) === "pressure"
                                                        ? "סף סטייה לתקינות לחץ במיכל חם"
                                                        : translateSpecKey(fieldName)}
                                        </span>

                                        <input
                                            className="spec-input"
                                            type="number"
                                            step="any"
                                            value={value}
                                            onChange={(e) =>
                                                handleChange(
                                                    documentId,
                                                    fieldName,
                                                    e.target.value
                                                )
                                            }
                                        />
                                    </label>
                                ))}
                        </div>
                    </section>
                ))}
            </div>

            <div className="edit-specs-actions">
                <button
                    className="btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                >
                    {saving
                        ? <BeerLoader message="שומר..." size="spinner" />
                        : "שמור שינויים"}
                </button>
            </div>
        </div>
    );
}
