// Safety wrapper for the expensive weekly style-average rebuild.
//
// runAsyncMaintenance_ executes every five minutes. The underlying weekly
// rebuild scans brews and their measurement subcollections, so a failed rebuild
// must never become a five-minute retry loop. This wrapper adds a durable
// attempt cooldown before any Firestore reads start, plus an execution lock to
// prevent overlapping manual/maintenance runs.

const WEEKLY_STYLE_MODEL_LAST_ATTEMPT_KEY_ = "weekly_style_averages_last_attempt_v2";
const WEEKLY_STYLE_MODEL_RETRY_BACKOFF_MS_ = 24 * 60 * 60 * 1000;
const WEEKLY_STYLE_MODEL_LOCK_WAIT_MS_ = 1000;

// Keep a reference to the implementation declared in
// calculateWeeklyStyleAverages.js, then replace the public entry point with the
// guarded version. Apps Script resolves function declarations project-wide
// before evaluating top-level initializers.
const calculateWeeklyStyleAveragesUnsafe_ = calculateWeeklyStyleAverages;

calculateWeeklyStyleAverages = function(force) {
  force = force === true;

  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const lastRunAt = Number(props.getProperty(WEEKLY_STYLE_MODEL_LAST_RUN_KEY) || 0);

  // Preserve the original weekly success throttle without entering the
  // expensive implementation merely to discover that it is not due.
  if (!force && lastRunAt && now - lastRunAt < WEEKLY_STYLE_MODEL_INTERVAL_MS) {
    return {
      skipped: true,
      reason: "weekly_throttle",
      lastRunAt: new Date(lastRunAt).toISOString()
    };
  }

  const lastAttemptAt = Number(
    props.getProperty(WEEKLY_STYLE_MODEL_LAST_ATTEMPT_KEY_) || 0
  );

  // A failed weekly rebuild is allowed to retry only after a full day. This is
  // deliberately much longer than the five-minute maintenance cadence: the
  // model is weekly and stale model data is safer than burning the Firestore
  // daily read quota in a retry storm.
  if (!force && lastAttemptAt && now - lastAttemptAt < WEEKLY_STYLE_MODEL_RETRY_BACKOFF_MS_) {
    return {
      skipped: true,
      reason: "retry_backoff",
      lastAttemptAt: new Date(lastAttemptAt).toISOString(),
      retryAfterMinutes: Math.max(
        1,
        Math.ceil((WEEKLY_STYLE_MODEL_RETRY_BACKOFF_MS_ - (now - lastAttemptAt)) / 60000)
      )
    };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(WEEKLY_STYLE_MODEL_LOCK_WAIT_MS_)) {
    return {
      skipped: true,
      reason: "already_running"
    };
  }

  try {
    // Record the attempt BEFORE the first Firestore read. If the rebuild throws,
    // times out, or Apps Script terminates the execution, the next five-minute
    // maintenance run still sees the backoff marker and will not rescan.
    props.setProperty(WEEKLY_STYLE_MODEL_LAST_ATTEMPT_KEY_, String(now));

    const result = calculateWeeklyStyleAveragesUnsafe_(force);

    // Successful runs already update WEEKLY_STYLE_MODEL_LAST_RUN_KEY in the
    // original implementation. Keep lastAttemptAt as diagnostics; the weekly
    // success throttle takes precedence on following maintenance executions.
    return result;
  } finally {
    lock.releaseLock();
  }
};
