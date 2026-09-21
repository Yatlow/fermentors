import { useMemo, useState } from "react";
import type { Fermentor } from "../../App";
import "./BrewingView.css";

type BrewingSection = "create" | "recipes" | "form";

type Props = {
    brews: Fermentor[];
};

const SECTIONS: { id: BrewingSection; label: string; description: string }[] = [
    {
        id: "create",
        label: "יצירת בישול חדש",
        description: "יצירת אצווה חדשה למיכל מחוטא, לפי התכנון או באופן ידני.",
    },
    {
        id: "recipes",
        label: "עריכת מתכונים",
        description: "מתכונים, חומרי גלם ואצוות פעילות.",
    },
    {
        id: "form",
        label: "מילוי טופס בישול",
        description: "הזנת נתוני הבישול לאצוות שנמצאות בתהליך.",
    },
];

function tankType(tankNumber: unknown): "בודד" | "כפול" | "משולש" {
    const tank = Number(tankNumber);
    if (tank < 5) return "בודד";
    if (tank < 9) return "כפול";
    return "משולש";
}

export default function BrewingView({ brews }: Props) {
    const [section, setSection] = useState<BrewingSection>("create");

    const sanitizedTanks = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 5)
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews]
    );

    const waitingBrews = useMemo(
        () =>
            brews
                .filter((tank) => Number(tank.tankNumber) !== 1 && Number(tank.action) === 0)
                .sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)),
        [brews]
    );

    return (
        <main className="brewing-view" dir="rtl">
            <section className="brewing-hero">
                <div>
                    <h1>בישולים</h1>
                    <p>{SECTIONS.find((item) => item.id === section)?.description}</p>
                </div>
            </section>

            <nav className="brewing-section-tabs" aria-label="תפריטי בישולים">
                {SECTIONS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={section === item.id ? "active" : ""}
                        aria-pressed={section === item.id}
                        onClick={() => setSection(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>

            {section === "create" && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>מיכלים מחוטאים</h2>
                            <p>בשלב הבא נחבר לכל מיכל את המלצת הבישול מהתכנון ואת היצירה הידנית.</p>
                        </div>
                        <span className="brewing-count">{sanitizedTanks.length}</span>
                    </div>

                    {sanitizedTanks.length === 0 ? (
                        <div className="brewing-empty">אין כרגע מיכלי ייצור מחוטאים.</div>
                    ) : (
                        <div className="brewing-tank-grid">
                            {sanitizedTanks.map((tank) => (
                                <article className="brewing-tank-card" key={tank.id}>
                                    <div className="brewing-tank-card-top">
                                        <strong>מיכל {String(tank.tankNumber ?? tank.id)}</strong>
                                        <span>{tankType(tank.tankNumber)}</span>
                                    </div>
                                    <div className="brewing-tank-meta">
                                        <span>סטטוס: {tank.stage?.name || "מחוטא"}</span>
                                        {tank.batchNumber && <span>אצווה קודמת: {String(tank.batchNumber)}</span>}
                                    </div>
                                    <button type="button" disabled>
                                        יצירת בישול — בקרוב
                                    </button>
                                </article>
                            ))}
                        </div>
                    )}
                </section>
            )}

            {section === "recipes" && (
                <section className="brewing-panel">
                    <h2>מתכונים וחומרי גלם</h2>
                    <p>
                        כאן ירוכזו מתכוני הבירה, אצוות חומרי הגלם ונתוני AA. עד לחיבור הנתונים
                        נשאיר את עריכת ה-AA הפעילה גם במסך הגדרות המערכת.
                    </p>
                </section>
            )}

            {section === "form" && (
                <section className="brewing-panel">
                    <div className="brewing-panel-heading">
                        <div>
                            <h2>אצוות לפני / בזמן בישול</h2>
                            <p>כאן ייפתח ה-Stepper להזנת נתוני הבישול.</p>
                        </div>
                        <span className="brewing-count">{waitingBrews.length}</span>
                    </div>

                    {waitingBrews.length === 0 ? (
                        <div className="brewing-empty">אין כרגע אצוות ב-ACTION 0.</div>
                    ) : (
                        <div className="brewing-tank-grid">
                            {waitingBrews.map((tank) => (
                                <article className="brewing-tank-card" key={tank.id}>
                                    <div className="brewing-tank-card-top">
                                        <strong>
                                            {tank.batchNumber ? `אצווה ${String(tank.batchNumber)}` : "אצווה חדשה"}
                                        </strong>
                                        <span>{String(tank.beerStyle || "")}</span>
                                    </div>
                                    <div className="brewing-tank-meta">
                                        <span>מיכל {String(tank.tankNumber ?? tank.id)}</span>
                                        <span>{tank.brewProgress?.stageName || "עדיין לא בבישול"}</span>
                                    </div>
                                    <button type="button" disabled>
                                        פתיחת טופס — בקרוב
                                    </button>
                                </article>
                            ))}
                        </div>
                    )}
                </section>
            )}
        </main>
    );
}
