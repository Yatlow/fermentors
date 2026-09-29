import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, type Timestamp } from "firebase/firestore";
import { db } from "../../firebase";
import BeerLoader from "../general/Loading";

type UserConnectionRow = {
    id: string;
    email: string;
    lastLoggedIn: Timestamp | Date | null;
};

function toDate(value: UserConnectionRow["lastLoggedIn"]): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === "function") return value.toDate();
    return null;
}

function formatLastConnection(value: UserConnectionRow["lastLoggedIn"]): string {
    const date = toDate(value);
    if (!date) return "לא נרשם חיבור עדיין";
    return new Intl.DateTimeFormat("he-IL", {
        timeZone: "Asia/Jerusalem",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

export default function UserConnectionReport() {
    const [rows, setRows] = useState<UserConnectionRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                setLoading(true);
                setError("");
                const snapshot = await getDocs(collection(db, "approvedUsers"));
                if (cancelled) return;

                setRows(snapshot.docs.map((item) => {
                    const data = item.data();
                    return {
                        id: item.id,
                        email: String(data.email ?? item.id),
                        lastLoggedIn: (data.lastLoggedIn as Timestamp | undefined) ?? null,
                    };
                }));
            } catch (err) {
                console.error("Failed to load user connection report:", err);
                if (!cancelled) setError("שגיאה בטעינת חיבורי המשתמשים.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void load();
        return () => { cancelled = true; };
    }, []);

    const sortedRows = useMemo(
        () => [...rows].sort((a, b) => {
            const aTime = toDate(a.lastLoggedIn)?.getTime() ?? 0;
            const bTime = toDate(b.lastLoggedIn)?.getTime() ?? 0;
            return bTime - aTime || a.email.localeCompare(b.email);
        }),
        [rows],
    );

    if (loading) {
        return <div className="dashboard-loading"><BeerLoader message="טוען חיבורי משתמשים..." overlay={false} size="large" /></div>;
    }

    return (
        <div className="edit-specs-page" dir="rtl">
            <div className="edit-specs-header">
                <div>
                    <p className="editSpecsHeaderH1">חיבור אחרון לפי משתמש</p>
                    <p className="editSpecsHeaderH2">הזמן האחרון שבו האפליקציה זיהתה את המשתמש כמחובר. הדוח נטען רק בפתיחתו.</p>
                </div>
            </div>

            {error && <div className="edit-specs-message error">{error}</div>}

            {!error && (
                <section className="spec-card">
                    <div className="spec-card-header">
                        <h2>משתמשים מאושרים ({sortedRows.length})</h2>
                    </div>
                    <div className="spec-fields">
                        {sortedRows.map((row) => (
                            <div
                                className="spec-field"
                                key={row.id}
                                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", flexWrap: "wrap" }}
                            >
                                <span className="spec-field-label email-label" dir="ltr">{row.email}</span>
                                <strong>{formatLastConnection(row.lastLoggedIn)}</strong>
                            </div>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
