import fs from 'node:fs/promises';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';

const projectId = 'demo-fermentors';
const rules = await fs.readFile('firestore.rules', 'utf8');
const env = await initializeTestEnvironment({ projectId, firestore: { rules } });

try {
  const email = 'planner@example.com';
  const uid = 'planner-uid';
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'approvedUsers', email), { isPlannerUser: true, isAdmin: false });
  });

  const db = env.authenticatedContext(uid, { email }).firestore();
  const weekId = '2026-09-27';

  async function saveRevision(revision, packaging) {
    await runTransaction(db, async (tx) => {
      const weekRef = doc(db, 'planningWeeks', weekId);
      const revisionRef = doc(db, 'planningWeeks', weekId, 'revisions', String(revision));
      const brewQueueRef = doc(db, 'brewPlanningQueue', weekId);
      const shipmentQueueRef = doc(db, 'shipmentPlanningQueue', weekId);
      const current = await tx.get(weekRef);
      const createdAt = current.exists() ? current.data().createdAt : serverTimestamp();
      const week = {
        id: weekId,
        packaging,
        brews: [],
        note: '',
        maxRuns: 3,
        deliveries: [],
        deliveryDates: [],
        dismissedRecommendations: [],
        allowExceptions: false,
        changeReason: 'rules integration test',
        calendarEvents: [],
        calendarNotes: {},
        revision,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
        createdAt,
      };
      tx.set(weekRef, week);
      tx.set(revisionRef, week);
      tx.set(brewQueueRef, { id: weekId, revision, brews: [], updatedAt: serverTimestamp(), updatedBy: uid });
      tx.set(shipmentQueueRef, { id: weekId, revision, projectionVersion: 1, deliveries: [], updatedAt: serverTimestamp(), updatedBy: uid });
    });
  }

  await saveRevision(1, [{ id: 'tank8-kegs', tankNumber: '8', packageType: 'keg', date: '2026-09-29' }]);
  console.log('PASS first packaging save');

  await runTransaction(db, async (tx) => {
    const weekRef = doc(db, 'planningWeeks', weekId);
    const current = await tx.get(weekRef);
    const revision = 2;
    const next = { ...current.data(), revision, updatedAt: serverTimestamp(), updatedBy: uid };
    tx.set(weekRef, next);
    tx.set(doc(weekRef, 'revisions', String(revision)), next);
  });
  console.log('PASS unchanged week save');

  await saveRevision(3, [
    { id: 'tank8-kegs', tankNumber: '8', packageType: 'keg', date: '2026-09-29' },
    { id: 'tank8-bottles', tankNumber: '8', packageType: 'bottle', date: '2026-09-30' },
  ]);
  console.log('PASS second packaging save');

  // All manual, automatic and physical shipment changes share a strictly
  // monotonic revision. A client cannot overwrite the guard with a stale
  // or arbitrary revision, nor may an unapproved user mark pallets.
  const guard = doc(db, 'shipmentMarkingGuard', 'active');
  await setDoc(guard, { revision: 1, updatedAt: serverTimestamp(), updatedBy: uid });
  await setDoc(guard, { revision: 2, updatedAt: serverTimestamp(), updatedBy: uid });
  await assertFails(setDoc(guard, {
    revision: 2, updatedAt: serverTimestamp(), updatedBy: uid,
  }));
  await assertFails(setDoc(guard, {
    revision: 10, updatedAt: serverTimestamp(), updatedBy: uid,
  }));
  const visitor = env.authenticatedContext('unapproved', { email: 'visitor@example.com' }).firestore();
  await assertFails(setDoc(doc(visitor, 'shipmentMarkingGuard', 'active'), {
    revision: 3, updatedAt: serverTimestamp(), updatedBy: 'unapproved',
  }));
  console.log('PASS shipment marking revision and access checks');
} finally {
  await env.cleanup();
}
