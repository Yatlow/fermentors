// ================================================================
// ONE-TIME V3 PRESSURE MODEL CLEANUP
// ================================================================
// V4 is now the only ordinary-pressure recommendation model.
// Remove the obsolete V3 model documents and its historical backfill state
// exactly once. This never touches brews, measurements, styleAverages or
// bottomCarbonationModels.
// ================================================================

const PRESSURE_V3_CLEANUP_DONE_KEY = "pressure_v3_cleanup_done_v1";

function cleanupPressureV3Artifacts_() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(PRESSURE_V3_CLEANUP_DONE_KEY) === "1") {
    return { skipped: true, reason: "already_completed" };
  }

  const projectId = FIREBASE_PROJECT_ID;
  const baseUrl =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/pressureResponseModels?pageSize=100";

  let pageToken = "";
  let reads = 0;
  let deletes = 0;

  do {
    const url = pageToken
      ? baseUrl + "&pageToken=" + encodeURIComponent(pageToken)
      : baseUrl;
    const page = firestoreRequest_(url);
    const documents = page.documents || [];
    reads += documents.length;

    documents.forEach(function (document) {
      const name = String(document && document.name || "");
      if (!name) return;

      const response = UrlFetchApp.fetch(
        "https://firestore.googleapis.com/v1/" + name,
        {
          method: "delete",
          headers: {
            Authorization: "Bearer " + ScriptApp.getOAuthToken()
          },
          muteHttpExceptions: true
        }
      );

      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        deletes++;
        return;
      }

      if (code !== 404) {
        throw new Error(
          "V3 pressure model delete failed (" + code + "): " +
          response.getContentText()
        );
      }
    });

    pageToken = page.nextPageToken || "";
  } while (pageToken);

  [
    "pressure_model_backfill_v3_turbo",
    "pressure_model_backfill_v2_turbo"
  ].forEach(function (key) {
    props.deleteProperty(key);
  });

  props.setProperty(PRESSURE_V3_CLEANUP_DONE_KEY, "1");

  Logger.log(
    "V3 PRESSURE CLEANUP | deleted " + deletes +
    " model docs | reads " + reads +
    " | old backfill state removed"
  );

  return {
    skipped: false,
    deletedModelDocuments: deletes,
    reads: reads,
    oldBackfillStateRemoved: true
  };
}
