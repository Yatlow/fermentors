# דיווחי תקלות ציבוריים — מדריך פריסה

## כתובת הטופס

לאחר פריסת ה־Hosting והשרת:
`https://fermenter-dashboard-bada3.web.app/report-issue`
(גם `firebaseapp.com` אם קיים).

## מה קיים

* טופס ציבורי, ללא התחברות וללא קריאות Firestore או גישה ישירה ל־Google APIs מהדפדפן.
* Cloudflare Turnstile מאומת בשרת, בדיקת מקור, מגבלות קבצים, rate limit ו־idempotency.
* שמירת פניות בעמודות A:T הקיימות, והוספת מטא־דאטה U:AD ללא שינוי עמודות המקור. כותרות חדשות בשורה 4.
* אימות מוצר לפי `productCatalog` ב־Firestore (עם ברירת מחדל של קטלוג פרמנטורים), וקישור אירועים מאותה אצווה+לקוח+סוג תקלה.
* תמונות/סרטונים בתיקיית Drive, בתיקיית משנה לפי פנייה. אין שיתוף ציבורי אוטומטי לקבצים.
* מייל לכל פנייה ל־yochai@shapirobeer.co.il, מייל הסלמה על אירוע שלישי באותו מק״ט ב־90 יום, סיכום בכל יום א׳ 08:00 ושגרת ניסיון חוזר למייל שנכשל.

## לפני פריסה — חובה

1. להפוך את חשבון Google שדרכו שולחים ומאחסנים למורשה עריכה של הגיליון ושל תיקיית Drive. בדקו *גם הרשאות ירושה* בתיקיית בישולים: קבצים המאוחסנים תחת תיקייה משותפת יורשים הרשאות מההורה.
2. להגדיר OAuth client באותו פרויקט, להעניק מראש הסכמה לחשבון (offline access עם refresh token) עבור
   `https://www.googleapis.com/auth/spreadsheets`,
   `https://www.googleapis.com/auth/drive`,
   `https://www.googleapis.com/auth/gmail.send`.
   אין לשמור את ה־refresh token ב־GitHub או בקוד לקוח.
3. להגדיר Turnstile באתר Cloudflare ולהרשות את שמות המארחים שבהם יוגש הטופס.
4. בפרויקט Firebase `fermenter-dashboard-bada3` להפעיל Billing/Blaze וכן Cloud Functions, Cloud Scheduler, Secret Manager, Firestore ו־Google Sheets/Drive/Gmail APIs עם ההרשאות המתאימות.
5. ב־Firebase CLI להגדיר secrets:
   `firebase functions:secrets:set QUALITY_GOOGLE_CLIENT_ID`
   `firebase functions:secrets:set QUALITY_GOOGLE_CLIENT_SECRET`
   `firebase functions:secrets:set QUALITY_GOOGLE_REFRESH_TOKEN`
   `firebase functions:secrets:set QUALITY_TURNSTILE_SECRET`.
   המפתחות לעולם אינם נחשפים לדפדפן.
6. פרמטרים שאינם סוד ל־Functions (קובץ `functions/.env.<project-id>` שאינו ב־Git):
   `QUALITY_SHEET_ID=19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4`
   `QUALITY_MEDIA_FOLDER_ID=1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn`
   `QUALITY_SENDER_EMAIL=<כתובת Google המאושרת לשליחת מייל>`
   `QUALITY_ALLOWED_HOSTS=fermenter-dashboard-bada3.web.app,fermenter-dashboard-bada3.firebaseapp.com`
7. ב־GitHub Actions variable `VITE_QUALITY_TURNSTILE_SITE_KEY` להגדיר את ה־site key הפומבי. ריצה מקומית — באמצעות `.env.local` ולא `.env.example`.

## בדיקות ופריסה

```bash
node --check functions/index.mjs
node --test functions/tests/*.test.mjs
npm ci && npm run build
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions:quality-reports --project fermenter-dashboard-bada3
npx firebase-tools deploy --only hosting --project fermenter-dashboard-bada3
```

**אל תשלחו דיווחי אמת בזמן בדיקות.** בצעו תחילה בדיקה בסביבת ניסוי/עותק של הגיליון. יש לאמת כתיבת Sheet, קישורי Drive, שליחת Gmail ושגרה שבועית לפני פרסום הקישור. פריסת Hosting לבדה אינה מספיקה.

### תחזוקה ותקלות

* Google Sheets API משמש כ־source of truth לדיווחים (ולא Firestore). Firestore שומר רק מזהי פעולה, מונים, מגבלת קצב ומצב משלוח מייל.
* שירות OAuth שברשותו `drive` צריך הרשאות כתיבה לתיקייה הקיימת, ושולח Gmail צריך להיות הבעלים או alias מאומת.
* תהליך אימות הספאם כולל אימות Turnstile בשרת; הגדרות ה־Turnstile והדומיין חייבות להתאים.
* אם מייל נכשל אחרי שמירה בגיליון, הפנייה עדיין נשמרת ומנגנון retry בודק אחת לשעה (עד 12 ניסיונות).

## Deployment strategy — staged rollout

The PR Preview is a **visual preview only** until Turnstile and the live API are configured. It is not a public data-entry endpoint for real reports.
Deploy backend functions using the **manual** GitHub Actions workflow `quality-report-deploy.yml`, after setting OAuth/Turnstile secrets and the repo variables `QUALITY_SENDER_EMAIL`, `QUALITY_ALLOWED_HOSTS`.
The functions deploy workflow intentionally does *not* edit or deploy brewery Hosting. After a successful production end-to-end smoke test, merge the PR to deploy Hosting via the existing automatic workflow.
When the form is live, check mobile Safari / Chrome, including retry after network timeout and a second report on the same event.

### OAuth and permissions
The parent 'בישולים' Drive folder is shared, so attachments can inherit access by other folder members. Check the effective ACLs with the brewery's Drive administrator, and restrict access at the parent or choose a separate protected folder if quality-only visibility is required. This project never turns on 'anyone with the link' permissions for attached files.
A Google OAuth refresh token is required to use Sheets/Drive/Gmail. Use a production OAuth consent screen; a refresh token from a testing-only consent screen may expire quickly.

### Privacy and retention

Firestore stores SHA-256 of the normalized report to recognize duplicate submissions, rather than a plaintext copy of user-entered fields. Email content is kept only until it is delivered or needs retry, then deleted from the Firestore outbox. The Google Sheet remains the authoritative complaint record. Configure TTL cleanup for `qualityRateLimits.expiresAt` in Firebase, and review the organization's media retention requirements.
The public HTTPS function must have Cloud Run invoker access for unauthenticated submitters, and request authentication comes from server-verified Turnstile plus abuse controls.

### Large uploads / request timeouts

The public form submits directly to `https://europe-west1-fermenter-dashboard-bada3.cloudfunctions.net/qualityReport` by default rather than through Firebase Hosting, because Hosting function rewrites impose a 60-second request timeout. The regional Cloud Function is configured for 120 seconds and validates both the request Origin and the Turnstile hostname. The Hosting rewrite remains as a compatible same-origin fallback. Override the public endpoint using `VITE_QUALITY_API_URL` only if needed.

After deploying the backend, test a video upload on mobile data, including an interrupted/repeated request. If Firebase Cloud Functions' native HTTP request-size limits are exceeded, show a useful error and reduce or chunk file sizes before widening limits.
