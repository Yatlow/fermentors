import fs from 'node:fs/promises';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
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
  await saveRevision(2, [
    { id: 'tank8-kegs', tankNumber: '8', packageType: 'keg', date: '2026-09-29' },
    { id: 'tank8-bottles', tankNumber: '8', packageType: 'bottle', date: '2026-09-30' },
  ]);
  console.log('PASS second packaging save');
} finally {
  await env.cleanup();
}
