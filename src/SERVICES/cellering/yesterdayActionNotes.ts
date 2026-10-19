import type { Measurement } from "./calculateCelleringRecomendations";

/** Show only actions recorded on the previous calendar day, never suggestions. */
export function yesterdayActionNotes(rows: Measurement[], yesterdayKey: string): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /העלאת\s*לחץ|הועלה\s*הלחץ|להעלות\s*לחץ/u,
    /הורדת\s*לחץ|הורד\s*הלחץ|להוריד\s*לחץ/u,
    /סגירת\s*נשם|נסגר\s*הנשם/u,
    /כיוון\s*פורק|כוון\s*הפורק/u,
    /מנוחת\s*דיאצטיל|דיאצטיל/u,
    /(?:הפעלת|הופעל|תחילת|התחלת|כיבוי|כובה|הפסקת|הופסק|סיום)\s*(?:ה)?קירור|קירור\s*(?:הופעל|כובה|הופסק)/u,
  ];
  for (const row of [...rows].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))) {
    if (String(row.id ?? "").slice(0, 10) !== yesterdayKey) continue;
    const notes = String(row.notes ?? "").trim();
    if (!notes) continue;
    for (const part of notes.split(/\n|[;；]|\s+·\s+/u)) {
      const note = part.trim();
      if (!note || !patterns.some(pattern => pattern.test(note))) continue;
      // Notes can include planned recommendations. These do not attest execution.
      if (/מומלץ|יש לבצע|מתוכנן|צפי|מחר|בעוד\s+\d+|לא בוצע/u.test(note)) continue;
      const normalized = note.replace(/^בוצע(?:ה)?\s*[:：-]?\s*/u, "").trim();
      if (normalized && !seen.has(normalized)) {
        actions.push(normalized);
        seen.add(normalized);
      }
    }
  }
  return actions;
}
