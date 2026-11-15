import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, FlaskConical, LoaderCircle } from "lucide-react";
import type { Fermentor } from "../../App";
import type { SpecChart } from "../../SERVICES/getAndPost/getSpecsFromFb";
import { getBrewsSummaryPage, type BrewSummary } from "../../SERVICES/getAndPost/getAllBrews";
import { getMeasurementsByBatch } from "../../SERVICES/getAndPost/gettAllDataByBatch";
import { batchWasPackaged, saveWarmFermentationTest } from "../../SERVICES/cellering/warmFermentationTestStore";
import {
    coolingPlatoAtRecordedCooling, getWarmFermentationGapThreshold, normalizeWarmBatch, parseWarmPlato,
    warmTestBlocksCooling, warmTestWarning,
} from "../../SERVICES/cellering/warmFermentationTest";
import "./WarmFermentationTest.css";

type Props = { brews: Fermentor[]; specs: SpecChart | null };
type BatchChoice = BrewSummary & { tankId?: string };
const ERROR_TEXT = "לא ניתן להביא את נתוני האצווה. אפשר לנסות שוב.";

export default function WarmFermentationTest({ brews, specs }: Props) {
    const active = useMemo<BatchChoice[]>(() => brews
        .filter(t => Number(t.action) === 1 && Number(t.tankNumber) !== 1 && t.batchNumber)
        .map(t => ({
            id: String(t.batchNumber), batchNumber: normalizeWarmBatch(t.batchNumber),
            beerStyle: String(t.beerStyle ?? ""), brewDate: String(t.brewDate ?? ""),
            sheetUrl: String(t.sheetUrl ?? ""), tankNumber: String(t.tankNumber ?? ""),
            tankId: t.id,
        })).sort((a, b) => Number(a.tankNumber) - Number(b.tankNumber)), [brews]);
    const activeIds = useMemo(() => new Set(active.map(t => t.batchNumber)), [active]);
    const [history, setHistory] = useState<BrewSummary[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selected, setSelected] = useState("");
    const [platoInput, setPlatoInput] = useState("");
    const [coolingPlato, setCoolingPlato] = useState<number | null>(null);
    const [packaged, setPackaged] = useState(false);
    const [loadingDetails, setLoadingDetails] = useState(false);
    const [detailsError, setDetailsError] = useState("");
    const [showWarning, setShowWarning] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const choice = useMemo<BatchChoice | undefined>(() => {
        const choices: BatchChoice[] = [...active, ...history];
        return choices.find(t => t.batchNumber === selected);
    }, [active, history, selected]);
    const tank = active.find(t => t.batchNumber === selected);
    const liveTank = tank ? brews.find(t => t.id === tank.tankId) : undefined;
    const isCold = liveTank?.stage?.name === "קר";
    const testPlato = parseWarmPlato(platoInput);
    const threshold = getWarmFermentationGapThreshold(specs);
    const warning = testPlato === null ? null : warmTestWarning({
        packaged, isCold, testPlato, coolingPlato, threshold,
    });
    const currentPlato = parseWarmPlato(liveTank?.currentData?.plato);
    const blocksCooling = warmTestBlocksCooling(liveTank?.stage?.name, currentPlato, testPlato);

    async function loadHistory(nextCursor: string | null, reset = false) {
        if (loadingMore) return;
        setLoadingMore(true);
        setError("");
        try {
            const collected: BrewSummary[] = [];
            let next = nextCursor;
            let more = true;
            // A page always contains 50 PREVIOUS batches, not 50 mixed with
            // batches already visible from the existing fermentors listener.
            while (collected.length < 50 && more) {
                const page = await getBrewsSummaryPage(next, 50 - collected.length);
                collected.push(...page.rows.filter(row => !activeIds.has(normalizeWarmBatch(row.batchNumber))));
                next = page.nextCursor;
                more = page.hasMore && next !== null;
            }
            setHistory(old => {
                const merged = reset ? collected : [...old, ...collected];
                return [...new Map(merged.map(row => [normalizeWarmBatch(row.batchNumber), row])).values()];
            });
            setCursor(next);
            setHasMore(more);
        } catch (e) {
            console.error("Warm test batch history failed", e);
            setError(ERROR_TEXT);
        } finally {
            setLoadingMore(false);
        }
    }

    // Historical reads only run when the new tab is actually mounted.
    useEffect(() => { void loadHistory(null, true); /* initial history only */ }, []);

    useEffect(() => {
        if (!selected || !choice) {
            setCoolingPlato(null); setPackaged(false); setDetailsError("");
            return;
        }
        let cancelled = false;
        setLoadingDetails(true);
        setCoolingPlato(null);
        setPackaged(false);
        setDetailsError("");
        const details = async () => {
            try {
                const [measurements, wasPackaged] = await Promise.all([
                    getMeasurementsByBatch(choice.batchNumber),
                    choice.tankId ? Promise.resolve(false) : batchWasPackaged(choice.batchNumber),
                ]);
                if (cancelled) return;
                setCoolingPlato(coolingPlatoAtRecordedCooling(measurements));
                setPackaged(wasPackaged);
            } catch (e) {
                console.error("Warm test comparison unavailable", e);
                if (!cancelled) setDetailsError("לא ניתן לאמת את מדידות הקירור או האריזה. אין לשמור לפני טעינה מחדש.");
            } finally {
                if (!cancelled) setLoadingDetails(false);
            }
        };
        void details();
        return () => { cancelled = true; };
    }, [selected, choice?.id, choice?.sheetUrl, choice?.tankId]);

    function chooseBatch(value: string) {
        setSelected(value); setPlatoInput(""); setMessage(""); setError(""); setShowWarning(false);
    }

    async function submit() {
        if (!choice || testPlato === null || saving || loadingDetails || detailsError) return;
        if (!choice.sheetUrl) { setError("לא נמצא גיליון בישול מקושר לאצווה"); return; }
        setSaving(true);
        setError("");
        try {
            const result = await saveWarmFermentationTest({
                batchNumber: choice.batchNumber, sheetUrl: choice.sheetUrl,
                plato: testPlato, coolingPlato, recordedAt: new Date().toISOString(),
                packaged, inTank: Boolean(choice.tankId), tankNumber: choice.tankNumber || null, tankId: choice.tankId ?? null,
            });
            setMessage(result.sheetSynced
                ? `בדיקת תסיסה חמה לאצווה #${choice.batchNumber} נשמרה בגיליון ובמערכת.`
                : `בדיקת תסיסה חמה לאצווה #${choice.batchNumber} נשמרה במערכת. הסנכרון לגיליון ממתין לניסיון חוזר אוטומטי.`);
            setShowWarning(false);
            setPlatoInput("");
            window.dispatchEvent(new CustomEvent("warm-fermentation-test-saved", { detail: { batchNumber: choice.batchNumber } }));
        } catch (e) {
            console.error("Warm test save failed", e);
            setError(e instanceof Error ? e.message : "שמירת הבדיקה נכשלה");
            setShowWarning(false);
        } finally {
            setSaving(false);
        }
    }

    function beginSave() {
        setMessage(""); setError("");
        if (warning) setShowWarning(true);
        else void submit();
    }

    const canSave = !!choice && !!choice.sheetUrl && testPlato !== null && !saving && !loadingDetails && !detailsError;

    return <section className="warm-test" dir="rtl" aria-label="בדיקת תסיסה חמה">
        <div className="warm-test-heading">
            <FlaskConical size={24} aria-hidden="true" />
            <div><h2>בדיקת תסיסה חמה</h2>
                <p>פרוטוקול קבוע: הדגרת הדגימה ב־35°C במשך 48 שעות. מזינים את הפלאטו בסיום הבדיקה; התוצאה אינה מחליפה מדידת סוכר יומית.</p>
            </div>
        </div>
        <div className="warm-test-fields">
            <label htmlFor="warm-test-batch">אצווה</label>
            <select id="warm-test-batch" value={selected} onChange={e => chooseBatch(e.target.value)}>
                <option value="">בחירת אצווה…</option>
                <optgroup label="אצוות במיכלים">
                    {active.map(t => <option key={t.batchNumber} value={t.batchNumber}>#{t.batchNumber} · {t.beerStyle} · מיכל {t.tankNumber}</option>)}
                </optgroup>
                <optgroup label="אצוות קודמות">
                    {history.filter(row => !activeIds.has(normalizeWarmBatch(row.batchNumber))).map(t =>
                        <option key={t.id} value={normalizeWarmBatch(t.batchNumber)}>#{t.batchNumber} · {t.beerStyle} · {t.brewDate || "ללא תאריך"}</option>)}
                </optgroup>
            </select>
            <button className="warm-test-more" type="button" disabled={loadingMore || !hasMore}
                onClick={() => void loadHistory(cursor)}>
                {loadingMore ? <LoaderCircle size={16} className="warm-spin" /> : <ChevronDown size={16}/>}
                {hasMore ? "טעינת 50 אצוות נוספות" : "כל האצוות נטענו"}
            </button>
            {choice && <div className="warm-test-batch-meta">אצווה #{choice.batchNumber} · {choice.beerStyle || "סגנון לא ידוע"} · {tank ? `מיכל ${tank.tankNumber}` : "אצווה היסטורית"}</div>}
            {choice && !tank && <label className="warm-test-check"><input type="checkbox" checked={packaged} disabled={loadingDetails} onChange={e => setPackaged(e.target.checked)} />האצווה כבר נארזה (לפי דיווחי אריזה; ניתן לתקן ידנית)</label>}
            {loadingDetails && <span className="warm-test-muted">טוען פלאטו בקירור ונתוני אריזה…</span>}
            {detailsError && <p role="alert" className="warm-test-error">{detailsError}</p>}
            {choice && !loadingDetails && <div className="warm-test-baseline">פלאטו בעת הקירור: <strong>{coolingPlato === null ? "אין תיעוד" : `${coolingPlato}°P`}</strong></div>}
            <label htmlFor="warm-test-plato">תוצאת הבדיקה באינקובטור (°P)</label>
            <input id="warm-test-plato" inputMode="decimal" type="text" value={platoInput}
                placeholder="לדוגמה: 2.6" onChange={e => setPlatoInput(e.target.value)}
                disabled={!choice || saving} aria-invalid={platoInput.trim() !== "" && testPlato === null}/>
            {platoInput.trim() && testPlato === null && <small className="warm-test-error">יש להזין פלאטו מספרי בין 0 ל־40.</small>}
            {blocksCooling && <p className="warm-test-notice" role="status"><AlertTriangle size={18}/> הפלאטו במיכל ({currentPlato}°P) גבוה מהתוצאה באינקובטור ({testPlato}°P). אין המלצה לקירור עד שהמיכל יגיע לערך הבדיקה או מתחתיו.</p>}
            {warning && <p className="warm-test-notice"><AlertTriangle size={18}/> קיים פער של לפחות {threshold}°P מול פלאטו הקירור. תוצג אזהרה לפני השמירה.</p>}
            {message && <p role="status" className="warm-test-success"><CheckCircle2 size={18}/> {message}</p>}
            {error && <p role="alert" className="warm-test-error">{error}</p>}
            <button type="button" className="warm-test-submit" disabled={!canSave} onClick={beginSave}>
                {saving ? "שומר…" : "שמירת בדיקת תסיסה חמה"}
            </button>
        </div>
        {showWarning && warning && <div className="warm-test-overlay">
            <div role="alertdialog" aria-modal="true" aria-labelledby="warm-warning-title" aria-describedby="warm-warning-body" className="warm-test-dialog">
                <h3 id="warm-warning-title"><AlertTriangle size={22}/> אזהרת פער בתסיסה</h3>
                <p id="warm-warning-body">{warning}</p>
                <p>הבדיקה תירשם עם השעה והתאריך. אין שינוי אוטומטי ביעדי הגיזוז או במדידות המקור.</p>
                <div className="warm-test-actions">
                    <button type="button" disabled={saving} onClick={() => setShowWarning(false)}>חזרה לבדיקה</button>
                    <button type="button" disabled={saving} onClick={() => void submit()}>{saving ? "שומר…" : "הבנתי, שמור"}</button>
                </div>
            </div>
        </div>}
    </section>;
}
