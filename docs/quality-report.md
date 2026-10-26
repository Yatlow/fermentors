# מערכת דיווחי איכות — Firebase + Apps Script עצמאי

## ארכיטקטורה ללא OAuth חיצוני
- טופס ציבורי, ללא התחברות: `https://fermenter-dashboard-bada3.web.app/report-issue` לאחר מיזוג ופריסת Hosting.
- Cloud Function `qualityReport`: Turnstile, ולידציה, מגבלות קבצים, הגנה מהצפה, שמירת מסמכים בתור פרטי `qualitySubmissions` ב־Firestore; קבצי מדיה נשמרים זמנית ב־Cloud Storage פרטי.
- Apps Script ייעודי `quality-appsscript/Code.js`, שמופעל כ־`brewcrew@shapirobeer.co.il` באמצעות טריגר כל 5 דקות. ללא Web App נוסף וללא ממשק פתוח לציבור.
- העובד מבצע Sheets, Drive ו־MailApp באמצעות ההרשאה של חשבון הביצוע שלו (`ScriptApp.getOAuthToken()`), בלי `Google Auth Platform` External, בלי Refresh Token חיצוני ובלי שינוי DNS.
- גיליון מקור קיים: `19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4`, טאב `גיליון1`, כותרות שורה 4; נתונים החל משורה 6. עמודות A:T נשמרות; מטא־דאטה U:AD; מזהה שליחה ב־AA.
- תיקיית מדיה קיימת: `1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn`. לא הופכים קבצים לציבוריים, וצריך לבדוק הרשאות ירושה בתיקיית ההורה.
- מייל יחיד ליוחאי על כל פנייה. כאשר יש שלושה אירועים נפרדים לפחות מאותה בירה ומאותה אצווה, ציון מספר האירועים ואזהרה בתוך המייל הרגיל. אין סיכום שבועי.
- לאחר קליטה ל־Firestore הטופס מציג אסמכתה זמנית ומבהיר שכתיבה לגיליון ומייל יתרחשו מאוחר יותר.

## הקמה והפעלה
הוראות מלאות: `quality-appsscript/README.md`.
1. לוודא שיש Firebase Cloud Storage פרטי בפרויקט, ושחשבון ההרצה של Cloud Function מסוגל ליצור אובייקטים בו.
2. לאשר ל־brewcrew גישת Firestore `roles/datastore.user` ברמת הפרויקט וגישה `roles/storage.objectUser` לבאקט בלבד, בהתאם למדיניות אבטחת הארגון.
3. ליצור **פרויקט Apps Script חדש ועצמאי תחת brewcrew** (לא לשנות את `server/.clasp.json` או את טריגרי הייצור).
4. להעלות `Code.js` + `appsscript.json`, להריץ `qualityInstallWorker` ולהעניק הרשאות פעם אחת. הסקריפט אינו נפרס כ־Web App.
5. לבצע בדיקת קצה מבוקרת דרך Preview לאחר פריסת הקוד החדש. לבדוק שורה ייחודית, מדיה, מייל ואזהרה באירוע שלישי.
6. רק לאחר אימות התור והעובד, לפרוס Hosting ולמזג PR #252.

## אבטחה ופרטיות
- יש גישה רק ל־Cloud Functions/Firestore ולמשתמש המורשה; Firestore Security Rules אינן מאפשרות לציבור לקרוא פניות.
- כל דיווח מכיל פרטי קשר ותיאור; הם נשמרים זמנית ב־Firestore, וקבצים זמנית ב־Cloud Storage. לאחר עיבוד מוצלח העובד מנקה את השדות הרגישים מרשומת התור ומנסה להסיר את הקבצים הזמניים.
- הצלחת 202 פירושה **הדיווח התקבל לתור**; אין להציג זאת כהצלחה ב־Sheets.
- לסקריפט אין `doPost`, `doGet` או הרשאה לקבל בקשות ציבוריות.
- לא לחשוף לאיש את סודות Turnstile או את מפתחות ה־Google הישנים.
- בעיית Google Branding הקודמת לא רלוונטית להפעלת Apps Script בהרשאות החשבון, בתנאי ש־Workspace וה־IAM מאפשרים את ההרשאות שנבחרו.

## פריסה
תהליך `.github/workflows/quality-report-deploy.yml` מפעיל רק את Firebase Functions ולא את Hosting. לאחר שהעובד יותקן ואושר, הרץ את הפריסה והסר בפועל את פונקציות `qualityReportWeekly` ו־`qualityReportMailRetry` ואת משימות Cloud Scheduler שלהן. דרושה הרשאת מחיקת משימות ל־CI או מחיקה יזומה של מפעיל מורשה.
תהליך ה־Preview נשאר ללא אפשרות שליחה עד להצבת משתנה `VITE_QUALITY_PREVIEW_SUBMISSIONS_ENABLED=true` באופן יזום.
