import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, orderBy, query, startAfter, type DocumentData, type QueryDocumentSnapshot, type Timestamp } from "firebase/firestore";
import { db } from "../../firebase";
import "./ActivityJournal.css";

type EventRow = { id: string; kind: string; tankNumber: string; batchNumber: string; details: string; actorEmail: string; occurredAt: Date | null };
const PAGE_SIZE = 30;
function toEvent(snapshot: QueryDocumentSnapshot<DocumentData>): EventRow {
    const d = snapshot.data();
    const timestamp = d.occurredAt as Timestamp | undefined;
    return { id: snapshot.id, kind: String(d.kind ?? ""), tankNumber: String(d.tankNumber ?? ""), batchNumber: String(d.batchNumber ?? ""), details: String(d.details ?? ""), actorEmail: String(d.actorEmail ?? ""), occurredAt: timestamp?.toDate?.() ?? null };
}
export default function ActivityJournal() {
    const [events, setEvents] = useState<EventRow[]>([]);
    const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [kind, setKind] = useState("הכל");
    const [tank, setTank] = useState("");
    const load = async (more: boolean, after: QueryDocumentSnapshot<DocumentData> | null = null) => {
        setLoading(true); setError("");
        try {
            const base = collection(db, "activityEvents");
            const q = after
                ? query(base, orderBy("occurredAt", "desc"), startAfter(after), limit(PAGE_SIZE))
                : query(base, orderBy("occurredAt", "desc"), limit(PAGE_SIZE));
            const snapshot = await getDocs(q);
            const rows = snapshot.docs.map(toEvent);
            setEvents(old => more ? [...old, ...rows] : rows);
            setCursor(snapshot.docs.at(-1) ?? null);
            setHasMore(snapshot.size === PAGE_SIZE);
        } catch (e) {
            console.error("Activity journal load failed", e);
            setError("לא ניתן לטעון את יומן הפעילות. בדוק הרשאות או חיבור לרשת.");
        } finally { setLoading(false); }
    };
    useEffect(() => { void load(false); }, []);
    const visible = useMemo(() => events.filter(event =>
        (kind === "הכל" || event.kind === kind) && (!tank.trim() || event.tankNumber.includes(tank.trim()))
    ), [events, kind, tank]);
    return <section className="activity-journal" dir="rtl" aria-label="יומן פעילות">
        <header className="activity-journal-header"><h2>יומן פעילות</h2><button type="button" onClick={() => void load(false)} disabled={loading}>רענון</button></header>
        <p className="activity-journal-note">יומן ניסיוני: מתעד דיווחי סלרינג ומדידות חדשים מהאפליקציה. אינו משחזר אירועים ישנים ואינו כולל עדיין שינויים בתכנון ובבישולים. שעת האירוע היא שעת שמירת התיעוד.</p>
        <div className="activity-journal-filters"><label>סוג פעולה <select value={kind} onChange={e => setKind(e.target.value)}><option>הכל</option><option>פעולות</option><option>אריזה</option><option>לחץ</option><option>חם</option></select></label><label>מיכל <input value={tank} onChange={e => setTank(e.target.value)} placeholder="מספר מיכל" inputMode="numeric" /></label></div>
        {error && <p role="alert">{error}</p>}
        <div className="activity-journal-list">{visible.map(event => <article key={event.id} className="activity-journal-item">
            <div className="activity-journal-item-top"><strong>{event.kind === "פעולות" ? "פעולות סלרינג" : event.kind === "אריזה" ? "אריזה" : event.kind === "לחץ" ? "טמפרטורה ולחץ" : "פלאטו ו־pH"}</strong><time>{event.occurredAt ? event.occurredAt.toLocaleString("he-IL") : "ממתין לחותמת זמן"}</time></div>
            <div>מיכל {event.tankNumber}{event.batchNumber ? ` · אצווה #${event.batchNumber}` : ""}</div>
            {event.details && <p>{event.details}</p>}
            <small>{event.actorEmail}</small>
        </article>)}</div>
        {!loading && !visible.length && !error && <p>אין אירועים התואמים לסינון בעמודים שנטענו.</p>}
        {loading && <p>טוען אירועים…</p>}
        {hasMore && <button type="button" onClick={() => void load(true, cursor)} disabled={loading}>טען עוד</button>}
    </section>;
}
