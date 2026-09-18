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

const PRESSURE_BACKFILL_STATE_KEY = "pressure_model_backfill_v2_turbo";
const PRESSURE_BACKFILL_PAGE_SIZE = 20;
const PRESSURE_BACKFILL_DAILY_READ_BUDGET = 8000;
const PRESSURE_BACKFILL_READ_HEADROOM = 1000;
const PRESSURE_BACKFILL_MAX_RUN_MS = 180000;
const PRESSURE_BACKFILL_TIMEZONE = "Asia/Jerusalem";

function pressureBackfillDayKey_(date) {
  const now = date || new Date();
  const shifted = new Date(now.getTime() - 11 * 60 * 60 * 1000);
  return Utilities.formatDate(
    shifted,
    PRESSURE_BACKFILL_TIMEZONE,
    "yyyy-MM-dd"
  );
}

function startPressureResponseBackfill_() {
  PropertiesService.getScriptProperties().setProperty(
    PRESSURE_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: "",
      processedBrews: 0,
      scannedBrews: 0,
      dailyReadDate: pressureBackfillDayKey_(new Date()),
      readsToday: 0,
      styleBrewCounts: {},
      styleSampleCounts: {},
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
  const startedAtMs = Date.now();
  const props = PropertiesService.getScriptProperties();
  let state = pressureResponseBackfillState_();

  // No state means this deployment has never backfilled historical brews.
  // Start once automatically. A completed state is kept permanently so the
  // historical scan never restarts after completion.
  if (!state) {
    state = {
      active: true,
      pageToken: "",
      processedBrews: 0,
      scannedBrews: 0,
      dailyReadDate: pressureBackfillDayKey_(new Date()),
      readsToday: 0,
      styleBrewCounts: {},
      styleSampleCounts: {},
      startedAt: new Date().toISOString()
    };
    props.setProperty(PRESSURE_BACKFILL_STATE_KEY, JSON.stringify(state));
    console.log("Pressure model historical TURBO backfill started automatically.");
  }

  if (state.active !== true) {
    return {
      skipped: true,
      reason: state.completed === true ? "completed" : "inactive",
      processedBrews: Number(state.processedBrews || 0),
      scannedBrews: Number(state.scannedBrews || 0)
    };
  }

  const todayKey = pressureBackfillDayKey_(new Date());
  if (String(state.dailyReadDate || "") !== todayKey) {
    state.dailyReadDate = todayKey;
    state.readsToday = 0;
  }

  const projectId = FIREBASE_PROJECT_ID;
  let pageToken = String(state.pageToken || "");
  let processedBrews = Number(state.processedBrews || 0);
  let scannedBrews = Number(state.scannedBrews || 0);
  let readsToday = Number(state.readsToday || 0);
  const styleBrewCounts = Object.assign({}, state.styleBrewCounts || {});
  const styleSampleCounts = Object.assign({}, state.styleSampleCounts || {});
  const readsAtStart = readsToday;
  let pagesProcessed = 0;
  let processedThisRun = 0;

  while (
    Date.now() - startedAtMs < PRESSURE_BACKFILL_MAX_RUN_MS &&
    readsToday < PRESSURE_BACKFILL_DAILY_READ_BUDGET - PRESSURE_BACKFILL_READ_HEADROOM
  ) {
    const page = pressureBackfillListPage_(projectId, pageToken);
    readsToday += page.documents.length;
    scannedBrews += page.documents.length;

    const samplesByStyle = {};
    let processedThisPage = 0;

    page.documents.forEach(function (document) {
      const id = String(document.name || "").split("/").pop();
      const data = firestoreFieldsToObject_(document.fields || {});
      const style = String(data.beerStyle || "").trim();
      const brewDate = parseDateOnly(data.brewDate);
      if (!id || !style || !brewDate) return;

      try {
        const measurements = getMeasurementsForBrew(projectId, id);
        // Firestore bills one document read for every measurement document
        // returned by the REST list call. Track it so the turbo run stays well
        // below the user's dedicated 10k/day historical-read allowance.
        readsToday += measurements.length;

        const styleKey = normalizePressureModelStyle_(style);
        if (!samplesByStyle[styleKey]) samplesByStyle[styleKey] = [];

        const brewSamples = buildPressureResponseSamplesForBrew_(
          measurements,
          brewDate,
          id
        );
        Array.prototype.push.apply(samplesByStyle[styleKey], brewSamples);

        styleBrewCounts[styleKey] = Number(styleBrewCounts[styleKey] || 0) + 1;
        styleSampleCounts[styleKey] =
          Number(styleSampleCounts[styleKey] || 0) + brewSamples.length;
        processedThisPage++;
      } catch (error) {
        console.log("Pressure backfill skipped brew " + id + ": " + error.message);
      }
    });

    // Each style write performs one model-document read before merging. Count
    // those reads too. Writes are only one document per touched style/page and
    // are orders of magnitude below the separate 10k/day write allowance.
    Object.keys(samplesByStyle).forEach(function (styleKey) {
      readsToday++;
      writeMergedPressureResponseModel_(
        projectId,
        styleKey,
        samplesByStyle[styleKey]
      );
    });

    processedBrews += processedThisPage;
    processedThisRun += processedThisPage;
    pagesProcessed++;

    if (!page.nextPageToken) {
      const completedState = {
        active: false,
        completed: true,
        processedBrews: processedBrews,
        scannedBrews: scannedBrews,
        dailyReadDate: todayKey,
        readsToday: readsToday,
        styleBrewCounts: styleBrewCounts,
        styleSampleCounts: styleSampleCounts,
        startedAt: state.startedAt || null,
        completedAt: new Date().toISOString()
      };
      props.setProperty(
        PRESSURE_BACKFILL_STATE_KEY,
        JSON.stringify(completedState)
      );
      console.log(
        "Pressure model historical TURBO backfill completed. " +
        "Brews processed: " + processedBrews +
        " | reads today: " + readsToday +
        " | brewsByStyle=" + JSON.stringify(styleBrewCounts) +
        " | samplesByStyle=" + JSON.stringify(styleSampleCounts)
      );
      return {
        skipped: false,
        completed: true,
        processedBrews: processedBrews,
        scannedBrews: scannedBrews,
        processedThisRun: processedThisRun,
        pagesProcessed: pagesProcessed,
        readsThisRun: readsToday - readsAtStart,
        readsToday: readsToday
      };
    }

    pageToken = page.nextPageToken;

    // Persist progress after every page. If Apps Script is terminated between
    // pages, the next maintenance invocation resumes from the next page rather
    // than rescanning the completed one.
    state = {
      active: true,
      pageToken: pageToken,
      processedBrews: processedBrews,
      scannedBrews: scannedBrews,
      dailyReadDate: todayKey,
      readsToday: readsToday,
      styleBrewCounts: styleBrewCounts,
      styleSampleCounts: styleSampleCounts,
      startedAt: state.startedAt || new Date().toISOString()
    };
    props.setProperty(PRESSURE_BACKFILL_STATE_KEY, JSON.stringify(state));
  }

  const budgetPaused =
    readsToday >= PRESSURE_BACKFILL_DAILY_READ_BUDGET - PRESSURE_BACKFILL_READ_HEADROOM;

  console.log(
    "Pressure TURBO backfill paused: " +
    (budgetPaused ? "daily read budget" : "execution time budget") +
    " | pages=" + pagesProcessed +
    " | readsThisRun=" + (readsToday - readsAtStart) +
    " | readsToday=" + readsToday +
    " | brewsByStyle=" + JSON.stringify(styleBrewCounts) +
    " | samplesByStyle=" + JSON.stringify(styleSampleCounts)
  );

  return {
    skipped: false,
    completed: false,
    pausedFor: budgetPaused ? "daily_read_budget" : "execution_time_budget",
    processedBrews: processedBrews,
    scannedBrews: scannedBrews,
    processedThisRun: processedThisRun,
    pagesProcessed: pagesProcessed,
    readsThisRun: readsToday - readsAtStart,
    readsToday: readsToday
  };
}
