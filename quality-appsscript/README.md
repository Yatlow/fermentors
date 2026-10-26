# Shapiro Quality Desk — immediate Apps Script processing

No DNS change, no corporate subdomain and no external OAuth consent screen.
This is an **isolated Apps Script Web App** running as
`brewcrew@shapirobeer.co.il`. Do not add these functions to the existing
brewery script in `server/` and do not modify its triggers.

## Immediate request flow

Anonymous visitor → Firebase HTTPS `qualityReport` (Turnstile, field/media
validation, rate limit) → private Firestore receipt + temporary Cloud Storage
blobs → **signed HTTP POST** to the standalone Apps Script Web App → Google
Sheets, Drive and MailApp **immediately**.

The Cloud Function sends only a submission UUID, a timestamp and an
HMAC-SHA256 signature. The secret never reaches a browser or the sheet.
The worker loads the actual report from private Firestore with its own
Google-managed Apps Script OAuth token; it uses no external Google Auth Platform
OAuth client and no rotating seven-day refresh token.

**Successful synchronous response** returns ticket number after the Sheet
write and mail submission. If Apps Script cannot complete, the public
response returns 202 (queued) with a temporary reference; the record stays
in Firestore to be retried through `qualityRecoverQueued` by an operator.
There is **no periodic five-minute polling trigger in the normal flow**.
Use a recovery trigger only if later explicitly approved, not as the default.

## Security and prerequisites

1. Confirm `brewcrew@shapirobeer.co.il` can edit the Sheet
   `19urjK3mUk1vO1clZ2IFDq-3ORqLeX5edBLmBeDwIud4`, including metadata
   U:AD, and can create files in Drive folder
   `1FrGg-gBKRyCSsw4EHTq8qb6zJEpWaQSn`.
2. Have the cloud project owner (subject to the organization's security
   policy) grant `brewcrew@shapirobeer.co.il`
   `roles/datastore.user` for project
   `fermenter-dashboard-bada3` and `roles/storage.objectViewer` scoped
   to its private bucket `fermenter-dashboard-bada3.firebasestorage.app`.
   Grant the function runtime service account permission to **create staged
   objects** in the bucket. No anonymous read or public links.
3. Create a standalone Apps Script project **while logged in as brewcrew**.
   Copy files `Code.js` and `appsscript.json` from this directory (or use
   `clasp` with a **new** script ID, never `server/.clasp.json`).
4. Create a random 48+ character signing key. Set it **in the standalone
   Apps Script project's Script Properties** as `QUALITY_WEBHOOK_SECRET`.
   Do not send the key into chat, commit it or expose it in HTML.
5. Store the **same** key in Google Secret Manager of
   `fermenter-dashboard-bada3` as `QUALITY_WEBHOOK_SECRET`. This is
   a new secret separate from Cloudflare Turnstile. The Cloud Functions runtime
   account requires `roles/secretmanager.secretAccessor` on this secret,
   and the GitHub deployment identity requires the existing narrowly scoped
   deployment permissions. Do not grant broad admin rights.
6. Run `qualityVerifyAndAuthorize` **as brewcrew** inside the standalone
   script editor and approve scopes. It checks access to Sheet, Drive
   and Firestore before accepting requests.
7. Deploy the standalone project as a **Web app**, Execute as **Me**
   (`brewcrew`), Who has access **Anyone**. This is not an unauthenticated
   action: every POST is rejected without a valid timestamp-bound server
   signature; the Web App has no read-only GET handler.
   **Security review required:** the public endpoint can be invoked by anyone,
   though they cannot perform an operation without the 48+ char secret.
   Do not proceed if organizational policy forbids even a signed public Web App.
8. Copy its `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`
   URL into GitHub **Environment → production → Variables** as
   `QUALITY_APPS_SCRIPT_URL`. Do not use the brewery production Apps Script URL.
   Config `QUALITY_UPLOAD_BUCKET` defaults to the private Firebase bucket.
9. After all prerequisites, deploy `functions:quality-reports` using the
   manual workflow. It updates the `qualityReport` Cloud Function.
   Remove old `qualityReportWeekly` and `qualityReportMailRetry`
   at cutover (including Cloud Scheduler jobs); the old Google client
   secrets are then no longer needed. A separate explicit cloud cleanup step
   may be needed if the GitHub identity lacks delete permissions.
10. Enable submissions **only in an authorized preview** and send a clearly
    marked test report. Check the user sees the real ticket after processing,
    the Sheet has exactly one row, media are in Drive, the recipient
    receives exactly one notification and the third-distinct-event note is
    correct. Only then merge/deploy public Hosting.

## Privacy, idempotency and recovery

* A complete report is sent only to the server; the signed webhook payload
  contains only UUID+timestamp+HMAC. Anonymous Firestore reads remain denied.
* Each UUID is an idempotency key. One writer at a time under ScriptLock,
  a Firestore update-time precondition, and a Sheet AA UUID check avoid
  duplicate rows and Drive folders on retries.
* MailApp may accept an email just before an Apps Script failure. A retry in
  that narrow window can send a duplicate email; this requires monitoring
  and can be hardened further before high-volume rollout.
* Worker writes queued → processing → completed, or back to queued on
  recoverable errors; repeated failures reach `dead`. The manual
  `qualityRecoverQueued` function handles exceptional retries.
* After success the worker clears sensitive Firestore fields and attempts
  to delete staged Storage blobs. Sheet records and Drive attachments are
  retained under existing brewery retention and sharing policies.
* Sheet metadata lives only in U:AD; existing A:T is untouched. Warnings
  begin with the **third distinct incident of the same beer+batch**,
  without a separate email or weekly report.

## Important limit

Apps Script Web Apps return via `ContentService` redirects; the Cloud
Function follows them. Google quotas / execution time apply. If Google
Workspace or corporate security blocks public Apps Script deployments,
do not bypass that policy. In that case, an approved service-account-only
Google API implementation is the alternative.
