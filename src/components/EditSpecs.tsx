import { useEffect, useState } from "react";
import { doc, updateDoc } from "firebase/firestore";

import { db } from "../firebase";
import {
    getSpecsFromFb,
    type SpecChart,
} from "../SERVICES/getSpecsFromFb";


export default function EditSpecs() {
    const [specs, setSpecs] = useState<SpecChart>({});

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");


    useEffect(() => {
        const loadSpecs = async () => {
            try {
                setLoading(true);
                setError("");

                const data = await getSpecsFromFb();

                setSpecs(data);
            } catch (err) {
                console.error(
                    "Error loading specs:",
                    err
                );

                setError(
                    "אירעה שגיאה בטעינת הנתונים"
                );
            } finally {
                setLoading(false);
            }
        };

        loadSpecs();
    }, []);

    const fieldTranslations: Record<string, string> = {
        bottleExpDat: "תוקף",
        kegBBE: "תוקף חבית",
        tolorances: "סף רגישות בחישוב המלצות",

        // General fields
        carbonation: "גיזוז",
        dryHopMinPlato: "מינימום פלאטו לדרייהופ",
        dycitalRestMinPlato: "מינימום פלאטו למנוחת דיאצטיל",
        pressure: "לחץ למיכל חם- אחרי סגירה",
        shutTankMinPlato: "מינימום פלאטו לסגירת מיכל",
        yeastDropMinPlato: "מינימום פלאטו להורדת שמרים",
        yeastDropMinPlatoLager: "מינימום פלאטו להורדת שמרים – לאגר",

        // Beer types
        ipa: "IPA",
        הופי: "הופי",
        חיטה: "חיטה",
        לאגר: "לאגר",
        סטאוט: "סטאוט",
        פייל: "פייל",
        other: "אחר",
    };
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

    // ============================================================
    // SAVE TO FIREBASE
    // ============================================================

    const handleSave = async () => {
        try {
            setSaving(true);

            setError("");
            setSuccess("");

            /*
             * עוברים על כל ה-documents שקיבלנו
             * ומעדכנים אותם חזרה ב-Firebase
             */

            const updates = Object.entries(specs).map(
                async ([documentId, values]) => {
                    const documentRef = doc(
                        db,
                        "specs",
                        documentId
                    );

                    await updateDoc(
                        documentRef,
                        values
                    );
                }
            );

            await Promise.all(updates);

            setSuccess(
                "השינויים נשמרו בהצלחה ✓"
            );

        } catch (err) {
            console.error(
                "Error saving specs:",
                err
            );

            setError(
                "אירעה שגיאה בשמירת הנתונים"
            );
        } finally {
            setSaving(false);
        }
    };

    // ============================================================
    // LOADING
    // ============================================================

    if (loading) {
        return (
            <div
                className="edit-specs-page"
                dir="rtl"
            >
                <div className="edit-specs-status">
                    טוען נתונים...
                </div>
            </div>
        );
    }

    // ============================================================
    // RENDER
    // ============================================================
    // const fieldOrder: Record<string, number> = {
    //     other: 999,
    //     kegBBE: 999,
    // };
    return (
        <div
            className="edit-specs-page"
            dir="rtl"
        >

            {/* ==================================================
                HEADER
               ================================================== */}

            <div className="edit-specs-header">

                <div>
                    <p className="editSpecsHeaderH1">
                        עריכת הגדרות לבירה
                    </p>

                    <p className="editSpecsHeaderH2">
                         שינוי הגדרות לחישוב המלצות ומתן תוקף בעת אריזה
                    </p>
                </div>

            </div>


            {/* ==================================================
                MESSAGES
               ================================================== */}

            {error && (
                <div className="edit-specs-message error">
                    {error}
                </div>
            )}

            {success && (
                <div className="edit-specs-message success">
                    {success}
                </div>
            )}


            {/* ==================================================
                DOCUMENTS
               ================================================== */}

            <div className="specs-list">

                {Object.entries(specs).map(
                    ([documentId, values]) => (

                        <section
                            className="spec-card"
                            key={documentId}
                        >

                            {/* ==============================
                    CARD HEADER
                   ============================== */}

                            <div className="spec-card-header">

                                <div>

                                    <h2>
                                        {fieldTranslations[documentId] ?? documentId}
                                    </h2>

                                </div>

                            </div>


                            {/* ==============================
                    FIELDS
                   ============================== */}

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

                                        const indexA =
                                            order.indexOf(fieldA);

                                        const indexB =
                                            order.indexOf(fieldB);

                                        return (
                                            (indexA === -1 ? 999 : indexA) -
                                            (indexB === -1 ? 999 : indexB)
                                        );
                                    })
                                    .map(([fieldName, value]) => (

                                        <label
                                            className="spec-field"
                                            key={fieldName}
                                        >

                                            <span className="spec-field-label">

                                                {documentId === "bottleExpDat"
                                                    ? fieldName === "kegBBE"
                                                        ? fieldTranslations[fieldName]
                                                        : `בקבוק ${fieldTranslations[fieldName]
                                                        ?? fieldName
                                                        }`
                                                    : fieldTranslations[fieldName]
                                                    ?? fieldName}

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

                    )
                )}

            </div>


            {/* ==================================================
                SAVE
               ================================================== */}

            <div className="edit-specs-actions">

                <button
                    className="btn-primary"
                    onClick={handleSave}
                    disabled={saving}
                >
                    {saving
                        ? "שומר..."
                        : "שמור שינויים"
                    }
                </button>

            </div>

        </div>
    );
}