import type { Measurement } from "./calculateCelleringRecomendations";

const number = String.raw`(\d+(?:[.,]\d+)?)`;
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
      // Reports usually store only the target; never invent a previous pressure.
      const directionMatch = note.match(/(?:העלאת|הורדת|העלו|הורידו|הועלה|הורד)\s*(?:ה)?לחץ/u);
      if (directionMatch) {
        const direction = /הורד/u.test(directionMatch[0]) ? "הורדת" : "העלאת";
        const explicitPair = note.match(new RegExp(`מ\\s*[-־:=]?\\s*${number}\\s*(?:bar|באר)?\\s*(?:ל|אל|עד|->|→)\\s*[-־:]?\\s*${number}`, "u"));
        const target = note.match(new RegExp(`(?:ל|אל|עד)\\s*[-־:]?\\s*${number}`, "u"));
        if (explicitPair) add(`${direction} לחץ: מ־${clean(explicitPair[1])} ל־${clean(explicitPair[2])} bar`);
        else if (target) add(`${direction} לחץ: ל־${clean(target[1])} bar`);
        else add(`${direction} לחץ`);
      }
      if (/סגירת\s*נשם|נסגר\s*(?:ה)?נשם/u.test(note)) add("סגירת נשם: הנשם נסגר");
      const valve = note.match(/(?:כיוון|כוון)\s*(?:ה)?פורק\s*(?:ל|אל)?\s*[-־:]?\s*(\d+(?:[.,]\d+)?)/u);
      if (valve) add(`כיוון פורק: ל־${clean(valve[1])} bar`);
      else if (/כיוון\s*פורק|כוון\s*הפורק/u.test(note)) add("כיוון פורק");
      if (/הורד(?:ת|ו)?\s*(?:(?:\d+(?:[.,]\d+)?)\s*)?(?:דליי?\s*)?שמרים|דליי?\s*שמרים|הוצאת\s*שמרים/u.test(note)) {
        const after = note.match(new RegExp(`לחץ\\s*(?:אחרי|לאחר)\\s*(?:(?:הורדת|הוצאת)\\s*)?(?:שמרים\\s*)?[:=]?\\s*${number}`, "u"));
        if (after) add(`הורדת שמרים: לחץ אחרי הורדת שמרים ${clean(after[1])} bar`);
        else add("הורדת שמרים");
      }
      if (/דיאצ(?:טיל|יטיל|יטל)/u.test(note) && /סיום\s*מנוחת|הסתיימה\s*מנוחת|חזר\s*לקירור/u.test(note)) add("חזרה לקירור: המיכל הוחזר לקירור");
      else if (/דיאצ(?:טיל|יטיל|יטל)/u.test(note)) add("מנוחת דיאצטיל: המיכל הועבר למנוחת דיאצטיל");
      else if (/חזר\s*לקירור|חזרה\s*לקירור|החזר(?:ת|ה)\s*לקירור/u.test(note)) add("חזרה לקירור: המיכל הוחזר לקירור");
      else if (/(?:הפעלת|הופעל|תחילת|התחלת)\s*(?:ה)?קירור|קירור\s*(?:הופעל|מיכל)/u.test(note)) add("קירור: המיכל הועבר לקירור");
    }
  }
  return actions;
}
