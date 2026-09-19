// ================================================================
// ONE-TIME V3 PRESSURE MODEL CLEANUP
// ================================================================
// V4 is now the only ordinary-pressure recommendation model.
// Remove the obsolete V3 model documents and its historical backfill state
// exactly once. This never touches brews, measurements, styleAverages or
// bottomCarbonationModels.
// ================================================================

const PRESSURE_V3_CLEANUP_DONE_KEY = "pressure_v3_cleanup_done_v2";

function cleanupPressureV3Artifacts_() {
  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(PRESSURE_V3_CLEANUP_DONE_KEY) === "1") {
    return { skipped: true, reason: "already_completed" };
  }

  const projectId = FIREBASE_PROJECT_ID;
  const collections = [
    "pressureResponseModels",
    "pressureResponseModelsV3"
  ];

  let reads = 0;
  let deletes = 0;
  const deletedByCollection = {};

  collections.forEach(function (collectionId) {
    let pageToken = "";
    let collectionDeletes = 0;

    do {
      const baseUrl =
        "https://firestore.googleapis.com/v1/projects/" +
        encodeURIComponent(projectId) +
        "/databases/(default)/documents/" +
        encodeURIComponent(collectionId) +
        "?pageSize=100";

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
          collectionDeletes++;
          return;
        }

        if (code !== 404) {
          throw new Error(
            "V3 pressure model delete failed for " + collectionId +
            " (" + code + "): " + response.getContentText()
          );
        }
      });

      pageToken = page.nextPageToken || "";
    } while (pageToken);

    deletedByCollection[collectionId] = collectionDeletes;
  });

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
    " | by collection=" + JSON.stringify(deletedByCollection) +
    " | old backfill state removed"
  );

  return {
    skipped: false,
    deletedModelDocuments: deletes,
    deletedByCollection: deletedByCollection,
    reads: reads,
    oldBackfillStateRemoved: true
  };
}
