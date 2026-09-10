const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp, getApps } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");
const { targets, selectVersion } = require("./checkpoints.cjs");
if (!getApps().length) initializeApp();
const db = getFirestore();
async function asOf(collection, id, cutoff) {
  const ref = db.collection(collection).doc(id);
  const [revisions, live] = await Promise.all([
    ref
      .collection("revisions")
      .where("updatedAt", "<=", Timestamp.fromDate(cutoff))
      .orderBy("updatedAt", "desc")
      .limit(1)
      .get(),
    ref.get(),
  ]);
  return selectVersion(
    revisions.docs.map((d) => d.data()),
    live.exists ? live.data() : null,
    +cutoff,
  );
}
async function capture(event, opening) {
  // scheduleTime is the intended cutoff, not invocation/retry time.
  if (!event.scheduleTime) throw new Error("Missing scheduler cutoff");
  const cutoff = new Date(event.scheduleTime);
  const points = targets(event.scheduleTime, opening);
  const settings = await asOf("planningSettings", "main", cutoff);
  for (const point of points) {
    const ref = db
      .collection("planningSnapshots")
      .doc(`${point.targetWeek}__${point.checkpoint}`);
    // Idempotent: successful checkpoints are immutable, including no-plan checkpoints.
    if ((await ref.get()).exists) continue;
    const plan = await asOf("planningWeeks", point.targetWeek, cutoff);
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return;
      tx.create(ref, {
        ...point,
        state: plan.state,
        plan: plan.value,
        settings: settings.value,
        settingsState: settings.state,
        scheduledFor: Timestamp.fromDate(cutoff),
        capturedAt: FieldValue.serverTimestamp(),
        schemaVersion: 2,
      });
    });
  }
}
const common = {
  timeZone: "Asia/Jerusalem",
  region: "europe-west1",
  retryCount: 3,
  memory: "256MiB",
  timeoutSeconds: 120,
  maxInstances: 1,
};
exports.planningFridaySnapshots = onSchedule(
  { ...common, schedule: "0 12 * * 5" },
  (event) => capture(event, false),
);
exports.planningOpeningSnapshot = onSchedule(
  { ...common, schedule: "0 0 * * 0" },
  (event) => capture(event, true),
);
