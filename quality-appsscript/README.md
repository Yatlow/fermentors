# Shapiro Quality Inbox — isolated Google Apps Script worker

This standalone script replaces the external OAuth client / refresh token entirely.
**Do not paste Code.js into the production brewery Apps Script.** It uses its own
five-minute clock trigger and runs as `brewcrew@shapirobeer.co.il`, with no web app
deployment and no public `doGet`/`doPost`.

## Architecture

1. Anonymous visitor posts to Firebase HTTPS `qualityReport`. Firebase verifies
   Turnstile, input format, IP rate limit and the upload file signatures.
2. Firebase stores a private `qualitySubmissions/{uuid}` document in Firestore
   (`status: queued`). Media is staged privately in Firebase Cloud Storage,
   bucket `fermenter-dashboard-bada3.firebasestorage.app`, prefix
   `quality-inbox/<uuid>/`.
3. This worker checks Firestore every five minutes as **brewcrew** using
   `ScriptApp.getOAuthToken()`. This OAuth token belongs to the Apps Script
   installation and is managed by Google, not by an external Google Auth
   Platform client. The worker reads private media using the Storage JSON API,
   copies it to the existing Drive folder, writes a single row to the
   existing complaint spreadsheet, then sends **one email per submission**
   using `MailApp.sendEmail`.
4. When three or more distinct incidents exist for the same **beer + batch**,
   include that count and warning in the ordinary email. There is no weekly
   summary. The worker retains completed Firestore documents only as
   idempotency receipts (without report, phone or media content).

The web form receives only a **temporary reference** and the statement that
the report has been queued. This is not a claim that it reached Sheets/Gmail.

## One-time user setup

1. Confirm `brewcrew@shapirobeer.co.il` can open and edit the spreadsheet
   `19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4` and add files inside
   Drive folder `1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn`.
2. In Google Cloud project `fermenter-dashboard-bada3`, grant the Google user
   `brewcrew@shapirobeer.co.il` **Firestore** role
   `roles/datastore.user` (scope: project) and **Storage Object User**
   `roles/storage.objectUser` scoped only to the Firebase Storage bucket.
   The Firebase Cloud Functions runtime SA needs write permission to that
   bucket (typically `roles/storage.objectCreator`, scoped to the bucket).
   These IAM changes must be approved by the project security policy.
3. Verify the bucket exists. Do **not** create a second public bucket and do
   **not** turn on public file access.
4. Sign into Google Apps Script / `clasp` with **brewcrew**. Create a **new,
   standalone** Apps Script project; upload `Code.js` and `appsscript.json`
   from this folder. Do not upload to `server/.clasp.json` (existing brewery
   script). To use clasp, run in this folder:
   `npx @google/clasp login`, then `npx @google/clasp create --type standalone
   --title "Shapiro Quality Inbox"` if no project exists, and
   `npx @google/clasp push`. Inspect the resulting `.clasp.json`: keep its
   script ID private and out of the production server directory.
5. In that script's editor, run `qualityInstallWorker` **as brewcrew**.
   Approve the permissions. This confirms Sheet/Drive/Firestore and installs
   exactly one `qualityReportWorker` clock trigger (every five minutes).
   If the organization's Google Workspace policy blocks these scopes, stop
   and request approved authorization; do not bypass Workspace controls.
6. Only when the worker is active and its logs show successful execution,
   deploy the new Firebase `functions:quality-reports` codebase and enable
   `VITE_QUALITY_PREVIEW_SUBMISSIONS_ENABLED=true` for an authorized,
   controlled Preview smoke test. Do not enable customer submissions until
   a test report is seen in Sheets, Drive and the recipient's inbox.

## Checking progress

* Apps Script → Executions / Triggers: `qualityReportWorker`, no web
  deployment.
* Firestore → `qualitySubmissions`: `queued`, `processing`, `completed`,
  `dead` after 8 failures. Logs show submission ID only.
* Sheet: row 4 headers U:AD; existing A:T unchanged; each UUID in column AA
  appears at most once.
* Attachments: private staging objects must be removed after successful
  processing; if cleanup is denied, find leftover
  `quality-inbox/` objects and grant bucket-scoped deletion rights.
* Email: MailApp runs as the account installing the trigger. Confirm the
  execution account before enabling customer traffic. Email delivery can be
  delayed by the worker polling interval.
* Worker is at-least-once: it avoids duplicate rows and Drive file names on
  retries. An interruption in the narrow window after an email is sent but
  before Firestore acknowledgment can lead to a duplicate email.

## Cutover / decommissioning

* Previous Cloud Functions `qualityReportWeekly` and
  `qualityReportMailRetry` must be explicitly removed at cutover, along
  with their Cloud Scheduler jobs. No residual scheduled email sender should
  use the old refresh token.
* Remove unused Secret Manager secrets
  `QUALITY_GOOGLE_CLIENT_ID`, `QUALITY_GOOGLE_CLIENT_SECRET`,
  `QUALITY_GOOGLE_REFRESH_TOKEN` **only after** the new intake and worker
  are verified; keep `QUALITY_TURNSTILE_SECRET`.
* If the Storage bucket does not exist or the service account lacks the
  required permissions, the Cloud Function returns a 500 error and does
  **not** acknowledge successful queueing. Resolve this first.
* Keep the public form hosted by Firebase at `/report-issue`. No corporate
  domain / DNS modification is needed. Google Auth Platform branding
  verification for the retired external OAuth app is unnecessary for the
  new worker architecture.
