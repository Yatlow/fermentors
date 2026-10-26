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
* מייל יחיד לכל פנייה ל־yochai@shapirobeer.co.il; כאשר קיימים לפחות שלושה אירועי תקלה נפרדים **מאותה בירה ואותה אצווה** (כולל הפנייה הנוכחית), מצוינת עובדה זו בתוך המייל הרגיל. אין סיכום שבועי. נשמר מנגנון ניסיון חוזר למייל שנכשל.

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
   `QUALITY_SENDER_EMAIL=brewcrew@shapirobeer.co.il` (ברירת מחדל בשרת)
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

**אל תשלחו דיווחי אמת בזמן בדיקות.** בצעו תחילה בדיקה בסביבת ניסוי/עותק של הגיליון. יש לאמת כתיבת Sheet, קישורי Drive, שליחת Gmail ושליחת התראה באירוע שלישי מאותה אצווה לפני פרסום הקישור. פריסת Hosting לבדה אינה מספיקה.

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

### Test-data vs live-data deployment

The manual Functions deployment workflow intentionally requires *separately configurable* repo variables `QUALITY_SHEET_ID` and `QUALITY_MEDIA_FOLDER_ID`, rather than hardcoding production IDs. For the first E2E deployment, point those variables at a **copy** of the existing complaint sheet and an isolated test-media folder. Do not open the public form to real customers during this stage. Once end-to-end submission, Drive links and Gmail alerts are verified, change the variables to production IDs below, redeploy backend, then merge for Hosting deployment:

* Production Sheet: `19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4`
* Production media folder: `1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn`

Never test on the production Sheet as a substitute for an isolated staging test.

## חשבון השירות המאושר (26.10.2026)

* **חשבון השירות:** `brewcrew@shapirobeer.co.il` — OAuth offline authorization for Sheets, Drive and Gmail. **Recipient:** `yochai@shapirobeer.co.il`.
* **אימות הרשאות Drive:** ל־brewcrew קיימת הרשאת `writer` גם לגיליון `תקלות אצל נקודות קצה` וגם לתיקייה `בישולים/אבטחת איכות/מדיה - דיווחי תקלות`. אין צורך לשתף מחדש.
* **הערת פרטיות:** תיקיית המדיה נמצאת תחת תיקיית `בישולים` המשותפת לעובדים נוספים; הקבצים עשויים לרשת גישה מהתיקייה. אין לטעון שהמדיה נגישה *רק* ליוחאי/צוות האיכות בלי תיקון הרשאות ברמת ההורה או מעבר לתיקייה מוגנת אחרת.
* **מה עוד צריך:** התחברות מאושרת לחשבון `brewcrew@shapirobeer.co.il` להנפקת OAuth refresh token לשלושת השירותים, שמירת פרטי OAuth ב־Firebase Secret Manager, חשבון שולח מתאים ל־Gmail, וכן מפתחות Cloudflare Turnstile ובדיקת אינטגרציה על עותק של הגיליון.
* לא לכתוב סיסמאות, קודי 2FA, client secrets או refresh tokens בשיחת GitHub, בקוד או ב־.env פומבי.

## עיצוב ועדכון טופס (26.10.2026)
- כותרת: ״מבשלת שפירא — מחלקת בקרת איכות״, לוגו מקורי מ־`src/assets/shpiro.jpeg`.
- קופי ענייני וידידותי במקום סלוגנים והומור; פלטת צבעים המבוססת על תוויות הבירה ושפת המותג של shapirobeer.co.il.
- סוג אריזה מחייב בחירה בין **חבית** ו־**בקבוק**; גם שרת ה־API דוחה פחית, אחר, ״לא ידוע״ או ערך חסר לדיווחים חדשים. פירוש דיווחים היסטוריים בגיליון לא משתנה.

### Preview readiness gate

The PR Preview can display and validate the form without connecting to the backend. By default, submissions are **disabled** when `VITE_DEPLOY_ENV=preview`. This avoids raw browser `Failed to fetch` errors while the `qualityReport` Cloud Function has not been deployed.

Only after the function is deployed, the preview hostname is approved both by Cloudflare Turnstile and `QUALITY_ALLOWED_HOSTS`, and a test copy of the Sheet is configured, set GitHub Actions repository variable `VITE_QUALITY_PREVIEW_SUBMISSIONS_ENABLED=true` and redeploy the preview. Remove or set it to false once testing finishes.

A Cloudflare checkmark proves only bot verification in the browser; it does not mean a report was saved. A network error with no server acknowledgement is ambiguous if a function is running (the server may have written and then disconnected), so verify the Sheet before resubmitting. The UI now uses a Hebrew connectivity error instead of surfacing `Failed to fetch`.

## החלטת משתמש — התראות (26.10.2026)
- **מייל אחד לכל דיווח**, ללא דוח שבועי וללא מייל הסלמה נפרד.
- מצטברים שלושה אירועים נפרדים של **אותה בירה ואותה אצווה** (ללא תלות במק״ט, באריזה ובגיל האירוע): החל מהשלישי, תופיע הערת אזהרה במייל הרגיל עם מספר האירועים כולל הדיווח הנוכחי.
- כאשר שני דיווחים של אותו לקוח, אותה בירה, אותה אצווה ואותה קטגוריית תקלה משויכים לאירוע אחד, הם נספרים פעם אחת אך כל דיווח מקבל מייל.
- בלי אצווה ידועה אין ספירת אירועים משותפת ואין הערת אזהרה.
- לאחר הפריסה יש לוודא שפונקציית `qualityReportWeekly` והמשימה `firebase-schedule-qualityReportWeekly-europe-west1` נמחקו, ולא משאירים סיכומים מתוזמנים פעילים.
