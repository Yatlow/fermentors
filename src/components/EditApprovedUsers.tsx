import { useEffect, useState } from "react";
import {
    collection,
    getDocs,
    doc,
    setDoc,
    deleteDoc,
    serverTimestamp,

} from "firebase/firestore";

import { db } from "../firebase";
import { Trash2 } from 'lucide-react';

import emailjs from "@emailjs/browser";

// ============================================================
// TYPES
// ============================================================

type ApprovedUser = {
    id: string;
    email: string;
};

export default function EditApprovedUsers(
    { isAdmin }: { isAdmin: boolean }
) {
    const [users, setUsers] = useState<ApprovedUser[]>([]);
    const [newEmail, setNewEmail] = useState("");

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [showPermissionModal, setShowPermissionModal] = useState(false);

    // ============================================================
    // LOAD FROM FIREBASE
    // ============================================================

    const loadUsers = async () => {
        try {
            setLoading(true);
            setError("");

            const snapshot = await getDocs(
                collection(db, "approvedUsers")
            );

            const data: ApprovedUser[] = snapshot.docs.map((d) => ({
                id: d.id,
                email: (d.data().email as string) ?? d.id,
            }));

            data.sort((a, b) => a.email.localeCompare(b.email));

            setUsers(data);
        } catch (err) {
            console.error(
                "Error loading approved users:",
                err
            );

            setError(
                "אירעה שגיאה בטעינת הנתונים"
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadUsers();
    }, []);

    // ============================================================
    // HELPERS
    // ============================================================

    const isValidEmail = (value: string) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

    const emailToDocId = (value: string) =>
        value.trim().toLowerCase();

    // ============================================================
    // ADD
    // ============================================================

    const handleAdd = async () => {
        if (!isAdmin) {
            setShowPermissionModal(true);
            return;
        }

        const email = newEmail.trim().toLowerCase();

        setError("");
        setSuccess("");

        if (!isValidEmail(email)) {
            setError(
                "כתובת אימייל לא תקינה"
            );
            return;
        }

        const docId = emailToDocId(email);

        if (users.some((u) => u.id === docId)) {
            setError(
                "כתובת המייל כבר קיימת ברשימה"
            );
            return;
        }

        try {
            setSaving(true);

            const userRef = doc(
                db,
                "approvedUsers",
                docId
            );

            await setDoc(userRef, {
                email,
                addedAt: serverTimestamp(),
            });

            sendApprovalEmail(email)

            setUsers((prev) =>
                [...prev, { id: docId, email }]
                    .sort((a, b) => a.email.localeCompare(b.email))
            );

            setNewEmail("");

            setSuccess(
                "האימייל נוסף בהצלחה ✓"
            );
        } catch (err) {
            console.error(
                "Error adding approved user:",
                err
            );

            setError(
                "אירעה שגיאה בהוספת האימייל"
            );
        } finally {
            setSaving(false);
        }
    };

    // ============================================================
    // REMOVE
    // ============================================================

    const handleRemove = async (docId: string) => {
        if (!isAdmin) {
            setShowPermissionModal(true);
            return;
        }

        setError("");
        setSuccess("");

        try {
            setSaving(true);

            const userRef = doc(
                db,
                "approvedUsers",
                docId
            );

            await deleteDoc(userRef);

            setUsers((prev) =>
                prev.filter((u) => u.id !== docId)
            );

            setSuccess(
                "האימייל הוסר בהצלחה ✓"
            );
        } catch (err) {
            console.error(
                "Error removing approved user:",
                err
            );

            setError(
                "אירעה שגיאה בהסרת האימייל"
            );
        } finally {
            setSaving(false);
        }
    };
    const sendApprovalEmail = async (email: string) => {
        try {
            emailjs.send("service_r6sx6s2", "template_3dzpfwv", {
                email,
            },"SOy_TDtKEy-_xaKWw");
            emailjs.send("service_r6sx6s2", "template_uhrmohh", {
                email,
            },"SOy_TDtKEy-_xaKWw");
            
        } catch (err) {
            console.error("Error sending approval email:", err);
            // לא חוסמים את התהליך העיקרי אם שליחת המייל נכשלה
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

    return (
        <div
            className="edit-specs-page"
            dir="rtl"
        >

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
                        <div className="permission-modal-icon">
                            🔒
                        </div>

                        <h2>
                            אין הרשאה לשינוי
                        </h2>

                        <p>
                            רק מנהל מערכת יכול לנהל את רשימת המשתמשים המאושרים.
                        </p>

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
                    <p className="editSpecsHeaderH1">
                        ניהול משתמשים מאושרים
                    </p>

                    <p className="editSpecsHeaderH2">
                        הוספה והסרה של כתובות אימייל בעלות גישה למערכת
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
                ADD FORM
               ================================================== */}

            <section className="spec-card">

                <div className="spec-card-header">
                    <h2>
                        הוספת אימייל
                    </h2>
                </div>

                <div
                    className="spec-fields specific-flexheader"
                    style={{ display: "flex", gap: "8px", alignItems: "center" 
                       
                    }}
                >

                    <input
                        className="spec-input"
                        type="email"
                        placeholder="name@example.com"
                        value={newEmail}
                        disabled={saving}
                        onChange={(e) => setNewEmail(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                handleAdd();
                            }
                        }}
                        style={{ flex: 1 }}
                    />

                    <button
                        className="btn-primary"
                        onClick={handleAdd}
                        disabled={saving}
                    >
                        {saving ? "מוסיף..." : "הוסף"}
                    </button>

                </div>

            </section>


            {/* ==================================================
                USERS LIST
               ================================================== */}

            <div className="specs-list">

                <section className="spec-card">

                    <div className="spec-card-header">
                        <h2>
                            רשימת משתמשים מאושרים ({users.length})
                        </h2>
                    </div>

                    <div className="spec-fields">

                        {users.length === 0 && (
                            <p>
                                אין משתמשים מאושרים עדיין
                            </p>
                        )}

                        {users.map((user) => (
                            <div
                                className="spec-field"
                                key={user.id}
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                }}
                            >

                                <span className="spec-field-label email-label">
                                    {user.email}
                                </span>

                                <button
                                    className="btn-primary removeEmailBtn"
                                    onClick={() => handleRemove(user.id)}
                                    disabled={saving}
                                >
                                    <span>הסר</span>
                                    <Trash2 size={16} />
                                </button>

                            </div>
                        ))}

                    </div>

                </section>

            </div>

        </div>
    );
}