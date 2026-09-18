// ================================================================
// ONE-TIME HISTORICAL PRESSURE MODEL BACKFILL
// ================================================================
// The maintenance cycle starts this automatically exactly once after deploy.
// It then processes a small page every 5 minutes until every brew has been
// inspected. Existing pressureResponseModels samples are merged/deduped, so
// the normal weekly 12-month refresh never erases historical learning.
// startPressureResponseBackfill_() remains available only for an intentional
// manual re-run/reset.
// ================================================================

const PRESSURE_BACKFILL_STATE_KEY = "pressure_model_backfill_v1";
const PRESSURE_BACKFILL_PAGE_SIZE = 20;

function startPressureResponseBackfill_() {
  PropertiesService.getScriptProperties().setProperty(
    PRESSURE_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: "",
      processedBrews: 0,
      startedAt: new Date().toISOString()
    })
  );
  return { started: true };
}

function pressureResponseBackfillState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PRESSURE_BACKFILL_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    PropertiesService.getScriptProperties().deleteProperty(PRESSURE_BACKFILL_STATE_KEY);
    return null;
  }
}

function pressureBackfillListPage_(projectId, pageToken) {
  let url =
    "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(projectId) +
    "/databases/(default)/documents/brews?pageSize=" +
    PRESSURE_BACKFILL_PAGE_SIZE;

  if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
  const result = firestoreRequest_(url);
  return {
    documents: result.documents || [],
    nextPageToken: result.nextPageToken || ""
  };
}

function pressureResponseBackfillStep_() {
  const props = PropertiesService.getScriptProperties();
  let state = pressureResponseBackfillState_();

  // No state means this deployment has never backfilled historical brews.
  // Start once automatically. A completed state is kept permanently so the
  // historical scan does not restart on every maintenance cycle.
  if (!state) {
    state = {
      active: true,
      pageToken: "",
      processedBrews: 0,
      startedAt: new Date().toISOString()
    };
    props.setProperty(PRESSURE_BACKFILL_STATE_KEY, JSON.stringify(state));
    console.log("Pressure model historical backfill started automatically.");
  }

  if (state.active !== true) {
    return {
      skipped: true,
      reason: state.completed === true ? "completed" : "inactive",
      processedBrews: Number(state.processedBrews || 0)
    };
  }

  const projectId = FIREBASE_PROJECT_ID;
  const page = pressureBackfillListPage_(projectId, String(state.pageToken || ""));
  const samplesByStyle = {};
  let processedThisStep = 0;

  page.documents.forEach(function (document) {
    const id = String(document.name || "").split("/").pop();
    const data = firestoreFieldsToObject_(document.fields || {});
    const style = String(data.beerStyle || "").trim();
    const brewDate = parseDateOnly(data.brewDate);
    if (!id || !style || !brewDate) return;

    try {
      const measurements = getMeasurementsForBrew(projectId, id);
      const styleKey = normalizePressureModelStyle_(style);
      if (!samplesByStyle[styleKey]) samplesByStyle[styleKey] = [];

      Array.prototype.push.apply(
        samplesByStyle[styleKey],
        buildPressureResponseSamplesForBrew_(measurements, brewDate, id)
      );
      processedThisStep++;
    } catch (error) {
      console.log("Pressure backfill skipped brew " + id + ": " + error.message);
    }
  });

  Object.keys(samplesByStyle).forEach(function (styleKey) {
    writeMergedPressureResponseModel_(
      projectId,
      styleKey,
      samplesByStyle[styleKey]
    );
  });

  const processedBrews = Number(state.processedBrews || 0) + processedThisStep;

  if (!page.nextPageToken) {
    props.setProperty(
      PRESSURE_BACKFILL_STATE_KEY,
      JSON.stringify({
        active: false,
        completed: true,
        processedBrews: processedBrews,
        startedAt: state.startedAt || null,
        completedAt: new Date().toISOString()
      })
    );
    console.log("Pressure model historical backfill completed. Brews: " + processedBrews);
    return {
      skipped: false,
      completed: true,
      processedBrews: processedBrews,
      processedThisStep: processedThisStep
    };
  }

  props.setProperty(
    PRESSURE_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: page.nextPageToken,
      processedBrews: processedBrews,
      startedAt: state.startedAt || new Date().toISOString()
    })
  );

  return {
    skipped: false,
    completed: false,
    processedBrews: processedBrews,
    processedThisStep: processedThisStep
  };
}
