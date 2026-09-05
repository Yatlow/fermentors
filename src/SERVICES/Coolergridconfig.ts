// ============================================================
// תצורת הגריד הפיזי של המקרר
//
// אומת מולך: צד ימין = 5 עמודות. עמודה 1 = הצמודה לדלת (המזרחית) עם 4 שורות,
// עמודות 2-5 עם 5 שורות כל אחת. צד שמאל = שורה אחת, 5 עמודות (בד"כ עודפים/פילוס).
// המסדרון עצמו הוא גם משטח אחסון לשעת הצורך, ואין טעם לאכוף מגבלת עמודות עליו
// בצורה נוקשה - הגדרנו 6 "תאי בסיס" אבל את יכולה להוסיף עוד ל-CORRIDOR_COLUMNS
// בכל עת בלי לשבור שום דבר אחר.
//
// חשוב - כיוון תצוגה מול הגיליון המקורי:
// בגיליון (RTL) יש שתי דלתות בקצוות האופקיים של שורת המסדרון (ראה תמונת המקור).
// כאן אנחנו ממפים את זה כך שהמסדרון מוצג כשורה אחת, עם סמן "דלת" בכל קצה שלה
// (לא מעל/מתחת כמו בגרסה הקודמת) - זה בקומפוננטה, לא כאן.
//
// אם אחרי שתראי את זה על המסך תגלי שהעמודות הפוכות ביחס לגיליון האמיתי -
// פשוט הפכי את הדגל MIRROR_COLUMN_ORDER למטה. זה המקום היחיד שצריך לגעת בו.
// ============================================================

export const MIRROR_COLUMN_ORDER = false; // הפכי ל-true אם סדר העמודות הפוך מול הגיליון

export type CoolerColumnDef = {
    col: number;
    label: string;
    rows: number;
    /** שורות שניתן להשתמש בהן אך הן חוסמות מעבר בדלת - יוצג עליהן סימון אזהרה בלבד */
    cautionRows?: number[];
};

// צד ימין (מוצג למעלה, קרוב לדלת): עמודה 1 = 4 שורות (הצמודה לדלת), 2-5 = 5 שורות.
export const RIGHT_SIDE_COLUMNS_BASE: CoolerColumnDef[] = [
    { col: 1, label: "1", rows: 3, cautionRows: [3] },
    { col: 2, label: "2", rows: 3 },
    { col: 3, label: "3", rows: 3 },
    { col: 4, label: "4", rows: 3 },
    { col: 5, label: "5", rows: 3 },
];

// צד שמאל (מוצג למטה): שורה אחת, 5 עמודות - בד"כ עודפים/פילוס.
export const LEFT_SIDE_COLUMNS_BASE: CoolerColumnDef[] = [
    { col: 1, label: "1", rows: 1 },
    { col: 2, label: "2", rows: 1 },
    { col: 3, label: "3", rows: 1 },
    { col: 4, label: "4", rows: 1 },
    { col: 5, label: "5", rows: 1 },
    { col: 6, label: "6", rows: 1 },
];

// מסדרון: שורת תאים אופקית, ניתנת להרחבה לפי הצורך בפועל (אין חובה לעצור ב-6).
export const CORRIDOR_COLUMNS: CoolerColumnDef[] = [
    { col: 1, label: "1", rows: 1 },
    { col: 2, label: "2", rows: 1 },
    { col: 3, label: "3", rows: 1 },
    { col: 4, label: "4", rows: 1 },
    { col: 5, label: "5", rows: 1 },
    { col: 6, label: "6", rows: 1 },
];

function applyMirror(cols: CoolerColumnDef[]): CoolerColumnDef[] {
    return MIRROR_COLUMN_ORDER ? [...cols].reverse() : cols;
}

export const RIGHT_SIDE_COLUMNS = applyMirror(RIGHT_SIDE_COLUMNS_BASE);
export const LEFT_SIDE_COLUMNS = applyMirror(LEFT_SIDE_COLUMNS_BASE);

export function getColumnDef(
    side: "right" | "left" | "corridor",
    col: number
): CoolerColumnDef | undefined {
    const columns =
        side === "right" ? RIGHT_SIDE_COLUMNS : side === "left" ? LEFT_SIDE_COLUMNS : CORRIDOR_COLUMNS;
    return columns.find((c) => c.col === col);
}

// ------------------------------------------------------------
// "מקרר כישות" (סעיף 6 בבקשה שלך): מכינה קלה לעתיד שבו יהיה יותר ממקרר אחד.
// היום יש מקרר יחיד "main" עם התצורה הקבועה למעלה. אם בעתיד יתווסף מקרר נוסף,
// אפשר להרחיב את המפה הזו במקום לשכתב את כל הקומפוננטה. שינוי גדול יותר
// (מסמך "coolers/{id}" בפיירסטור עם תצורה דינמית) הוא הצעד הבא אם וכשתצטרכי
// יותר ממקרר אחד בפועל - לא מימשתי את זה עכשיו כי זה שינוי מבנה נתונים
// שדורש ממך להחליט על סכמה, לא רק קוד.
// ------------------------------------------------------------
export type CoolerId = "main";

export function getGridConfigForCooler(_coolerId: CoolerId) {
    return {
        rightColumns: RIGHT_SIDE_COLUMNS,
        leftColumns: LEFT_SIDE_COLUMNS,
        corridorColumns: CORRIDOR_COLUMNS,
    };
}