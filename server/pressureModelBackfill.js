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

const PRESSURE_BACKFILL_STATE_KEY = "pressure_model_backfill_v3_turbo";
const PRESSURE_BACKFILL_PREVIOUS_STATE_KEY = "pressure_model_backfill_v2_turbo";
const PRESSURE_BACKFILL_PAGE_SIZE = 20;
// Weekend V3 rebuild allowance: reserve up to 10k Firestore document reads
// for the historical model refresh. Stop around 9k counted reads so a final
// page plus unrelated app traffic still has roughly 1k of safety margin.
const PRESSURE_BACKFILL_DAILY_READ_BUDGET = 10000;
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

function pressureBackfillExistingReadsForDay_(dayKey) {
  const props = PropertiesService.getScriptProperties();
  let maxReads = 0;

  [PRESSURE_BACKFILL_STATE_KEY, PRESSURE_BACKFILL_PREVIOUS_STATE_KEY]
    .forEach(function (key) {
      const raw = props.getProperty(key);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (String(parsed.dailyReadDate || "") !== String(dayKey || "")) return;
        maxReads = Math.max(maxReads, Number(parsed.readsToday || 0));
      } catch (error) {
        // Ignore malformed historical state; the active V3 state will be
        // rewritten safely below.
      }
    });

  return maxReads;
}

function startPressureResponseBackfill_() {
  const dayKey = pressureBackfillDayKey_(new Date());
  PropertiesService.getScriptProperties().setProperty(
    PRESSURE_BACKFILL_STATE_KEY,
    JSON.stringify({
      active: true,
      pageToken: "",
      processedBrews: 0,
      scannedBrews: 0,
      dailyReadDate: dayKey,
      readsToday: pressureBackfillExistingReadsForDay_(dayKey),
      styleBrewCounts: {},
      styleSampleCounts: {},
      equilibriumStyleObservationCounts: {},
      bottomStyleSampleCounts: {},
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
      readsToday: pressureBackfillExistingReadsForDay_(
        pressureBackfillDayKey_(new Date())
      ),
      styleBrewCounts: {},
      styleSampleCounts: {},
      equilibriumStyleObservationCounts: {},
      bottomStyleSampleCounts: {},
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
  const equilibriumStyleObservationCounts = Object.assign(
    {},
    state.equilibriumStyleObservationCounts || {}
  );
  const bottomStyleSampleCounts = Object.assign(
    {},
    state.bottomStyleSampleCounts || {}
  );
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
    const equilibriumByStyle = {};
    const bottomSamplesByStyle = {};
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
        if (!equilibriumByStyle[styleKey]) equilibriumByStyle[styleKey] = [];
        if (!bottomSamplesByStyle[styleKey]) bottomSamplesByStyle[styleKey] = [];

        const brewSamples = buildPressureResponseSamplesForBrew_(
          measurements,
          brewDate,
          id
        );
        const equilibriumObservations = buildPressureEquilibriumObservationsForBrew_(
          measurements,
          brewDate,
          id
        );
        const bottomSamples = buildBottomCarbonationSamplesForBrew_(
          measurements,
          brewDate,
          id
        );

        Array.prototype.push.apply(samplesByStyle[styleKey], brewSamples);
        Array.prototype.push.apply(
          equilibriumByStyle[styleKey],
          equilibriumObservations
        );
        Array.prototype.push.apply(bottomSamplesByStyle[styleKey], bottomSamples);

        styleBrewCounts[styleKey] = Number(styleBrewCounts[styleKey] || 0) + 1;
        styleSampleCounts[styleKey] =
          Number(styleSampleCounts[styleKey] || 0) + brewSamples.length;
        equilibriumStyleObservationCounts[styleKey] =
          Number(equilibriumStyleObservationCounts[styleKey] || 0) +
          equilibriumObservations.length;
        bottomStyleSampleCounts[styleKey] =
          Number(bottomStyleSampleCounts[styleKey] || 0) + bottomSamples.length;
        processedThisPage++;
      } catch (error) {
        console.log("Pressure backfill skipped brew " + id + ": " + error.message);
      }
    });

    // Each model write performs one model-document read before merging. Count
    // those reads too. Writes remain only one document per touched style/model.
    Object.keys(samplesByStyle).forEach(function (styleKey) {
      if (samplesByStyle[styleKey].length > 0) {
        readsToday++;
        writeMergedPressureResponseModel_(
          projectId,
          styleKey,
          samplesByStyle[styleKey],
          equilibriumByStyle[styleKey] || []
        );
      }

      if (
        bottomSamplesByStyle[styleKey] &&
        bottomSamplesByStyle[styleKey].length > 0
      ) {
        readsToday++;
        writeMergedBottomCarbonationModel_(
          projectId,
          styleKey,
          bottomSamplesByStyle[styleKey]
        );
      }
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
        equilibriumStyleObservationCounts: equilibriumStyleObservationCounts,
        bottomStyleSampleCounts: bottomStyleSampleCounts,
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
        " | pressureSamplesByStyle=" + JSON.stringify(styleSampleCounts) +
        " | equilibriumByStyle=" + JSON.stringify(equilibriumStyleObservationCounts) +
        " | bottomSamplesByStyle=" + JSON.stringify(bottomStyleSampleCounts)
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
      equilibriumStyleObservationCounts: equilibriumStyleObservationCounts,
      bottomStyleSampleCounts: bottomStyleSampleCounts,
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
    " | pressureSamplesByStyle=" + JSON.stringify(styleSampleCounts) +
    " | equilibriumByStyle=" + JSON.stringify(equilibriumStyleObservationCounts) +
    " | bottomSamplesByStyle=" + JSON.stringify(bottomStyleSampleCounts)
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
