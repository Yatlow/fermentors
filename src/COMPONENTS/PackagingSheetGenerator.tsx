import { useMemo, useState } from "react";
import type { Fermentor } from "../App";
import type { SpecChart } from "../SERVICES/getAndPost/getSpecsFromFb";
import { getCatalogEntry } from "../SERVICES/cooler/PalletCatalog";

type Props = { brews: Fermentor[]; specs: SpecChart | null };
type PackageKind = "crates" | "kegs";

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const addMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return d;
};
const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(-2)}`;
function specStyle(style: string | undefined | null) {
  const s = String(style || "").trim().toLowerCase();
  if (s.includes("ipa")) return "ipa";
  if (s.includes("פייל") || s.includes("pale")) return "פייל";
  if (s.includes("הופי") || s.includes("hoppy")) return "הופי";
  if (s.includes("חיטה") || s.includes("wheat")) return "חיטה";
  if (s.includes("לאגר") || s.includes("lager")) return "לאגר";
  if (s.includes("סטאוט") || s.includes("stout")) return "סטאוט";
  return "other";
}

export default function PackagingSheetGenerator({ brews, specs }: Props) {
  const candidates = useMemo(() => brews.filter((brew) => Number(brew.tankNumber) !== 1 && brew.batchNumber), [brews]);
  const [selection, setSelection] = useState("");
  const [kind, setKind] = useState<PackageKind>("kegs");
  const [date, setDate] = useState(isoToday());
  const brew = candidates.find((item) => String(item.id) === selection) ?? null;
  const expirySpec = specs?.bottleExpDat || {};
  const rawMonths = kind === "crates"
    ? (expirySpec[specStyle(brew?.beerStyle)] ?? expirySpec.other)
    : expirySpec.kegBBE;
  const months = Number(rawMonths);
  const hasExpiry = Number.isFinite(months) && months >= 0;
  const expiry = useMemo(() => hasExpiry ? fmt(addMonths(date, months)) : "", [date, hasExpiry, months]);
  const catalog = brew ? getCatalogEntry(brew.beerStyle, kind) : null;

  return <section className="pack-sheet-tool" dir="rtl">
    <h2>יצירת דף אריזה</h2>
    <div className="pack-sheet-controls">
      <label>מיכל / אצווה
        <select value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="">בחר מיכל / אצווה</option>
          {candidates.map((item) => <option key={item.id} value={String(item.id)}>מיכל {item.tankNumber} · {item.beerStyle} · אצווה {item.batchNumber}</option>)}
        </select>
      </label>
      <label>אריזה
        <select value={kind} onChange={(event) => setKind(event.target.value as PackageKind)}>
          <option value="kegs">חבית</option><option value="crates">בקבוקים</option>
        </select>
      </label>
      <label>תאריך אריזה<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <button className="btn-primary" disabled={!brew || !catalog || !hasExpiry} onClick={() => window.print()}>הדפס A4 לרוחב</button>
    </div>
    {brew && !catalog && <p className="edit-specs-message error">לא נמצא מק״ט מתאים בקטלוג עבור {brew.beerStyle}.</p>}
    {brew && !hasExpiry && <p className="edit-specs-message error">לא מוגדר תוקף מתאים ב-SPECS עבור סוג האריזה הזה.</p>}
    {brew && <div className="pack-sheet-print">
      <strong>{brew.beerStyle}</strong><b>{kind === "kegs" ? "חבית" : "בקבוקים"}</b><b>{brew.batchNumber}</b>
      <span>מק״ט</span><b>{catalog?.sku || "—"}</b><footer>פג תוקף {expiry || "—"}</footer>
    </div>}
    <style>{`@media screen{.pack-sheet-tool{padding:24px}.pack-sheet-controls{display:flex;gap:12px;flex-wrap:wrap}.pack-sheet-controls label{display:flex;flex-direction:column;gap:4px}.pack-sheet-print{margin:30px auto;padding:60px;max-width:900px;text-align:center;border:1px solid #ddd;display:flex;flex-direction:column;font-size:44px}.pack-sheet-print strong{font-size:72px}.pack-sheet-print footer{margin-top:35px}}@media print{@page{size:A4 landscape;margin:10mm}body *{visibility:hidden!important}.pack-sheet-print,.pack-sheet-print *{visibility:visible!important}.pack-sheet-print{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-family:Arial,sans-serif;font-size:44pt}.pack-sheet-print strong{font-size:64pt}.pack-sheet-print footer{margin-top:28pt}}`}</style>
  </section>;
}
