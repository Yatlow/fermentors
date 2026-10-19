import type { Measurement } from "./calculateCelleringRecomendations";

const number = String.raw`(\\d+(?:[.,]\\d+)?)`;
const clean = (value: string) => value.replace(",", ".");

/** Compact summaries of *recorded* actions, never the free-text note itself. */
export function yesterdayActionNotes(rows: Measurement[], yesterdayKey: string): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    if (!seen.has(label)) { seen.add(label); actions.push(label); }
  };
  for (const row of [...rows].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    if (String(row.id ?? "").slice(0, 10) !== yesterdayKey) continue;
    const notes = String(row.notes ?? "");
    for (const raw of notes.split(/\n|[;；]|\s+·\s+/u)) {
      const note = raw.trim();
      if (!note || /מומלץ|יש לבצע|מתוכנן|צפי|מחר|בעוד\s+\d+|לא בוצע/u.test(note)) continue;
      const pressure = note.match(new RegExp(`(?:העלאת|הורדת|העלו|הורידו|הועלה|הורד)\\s*(?:ה)?לחץ[^\\n]*?מ\\s*[:=]?\\s*${number}\\s*(?:bar|באר)?\\s*(?:ל|אל|עד|->|→)\\s*[-־:]?\\s*\\s*${number}`, "u"));
      if (pressure) {
        const direction = /הורד/u.test(note) ? "הורדת" : "העלאת";
        add(`${direction} לחץ מ־${clean(pressure[1])} ל־${clean(pressure[2])}`);
      } else if (/העלאת\s*לחץ|הועלה\s*הלחץ|הורדת\s*לחץ|הורד\s*הלחץ/u.test(note)) {
        const direction = /הורד/u.test(note) ? "הורדת" : "העלאת";
        add(`${direction} לחץ`);
      }

      if (/דליי?\s*שמרים|הורדת\s*שמרים|הורדו\s*שמרים/u.test(note)) {
        const after = note.match(new RegExp(`(?:לחץ\\s*אחרי|אחרי\\s*(?:דליי?\\s*)?שמרים[^\\d]*?לחץ)\\s*[:=]?\\s*${number}`, "u"));
        if (after) add(`לחץ אחרי שמרים ${clean(after[1])}`);
        else add("בוצעה הורדת שמרים");
      }
      if (/דיאצ(?:טיל|יטיל|יטל)/u.test(note) && !/סיום\s*מנוחת/u.test(note)) add("המיכל נכנס למנוחת דיאציטיל");
      else if (/(?:הפעלת|הופעל|תחילת|התחלת)\s*(?:ה)?קירור|קירור\s*הופעל/u.test(note)) add("המיכל קורר");
    }
  }
  return actions;
}
