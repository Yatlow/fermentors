/**
 * Decisions describe the actual instruction, not the alternative reporting
 * choices offered by the automatic carbonation recommendation.
 *
 * This also cleans legacy decisions already saved with a copied recommendation.
 * It is display-only for existing Firestore data; no document rewrite needed.
 */
export function stripPressureChoiceInstructions(text: string): string {
  return text
    .replace(/\s*ניתן לדווח על שינוי לחץ או לבחור להשאיר את הלחץ ללא שינוי, בהתאם לשיקול דעת המבשל\.?/gu, "")
    .replace(/\s*ניתן לשקול (?:הורדת|העלאת) לחץ או לבחור להשאיר את הלחץ ללא שינוי\.?/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function pressureDecisionContext(reason: string): string {
  return stripPressureChoiceInstructions(reason)
    .replace(/\s*מומלץ לבצע שינוי לחץ בהתאם (?:להמלצה הקיימת )?או לוודא שבוצע\.?/gu, "")
    .replace(/\s*מומלץ לבצע שינוי לחץ בהתאם\.?/gu, "")
    .replace(/[.\s]+$/u, "")
    .trim();
}
