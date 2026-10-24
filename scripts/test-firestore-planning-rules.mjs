import fs from 'node:fs/promises';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';

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
  // Direct writes must not bypass the shared guard. An operator is free to
  // create ordinary unmarked inventory, but marking it or shipping it needs
  // the matching guard increment in the very same transaction.
  const palletRef = doc(db, 'pallets', 'guard-test');
  await setDoc(palletRef, {
    zone: 'cooler', itemType: 'kegs', beerStyle: 'IPA',
    quantity: 20, markedForShipment: false, autoReservationWeek: null,
    autoReservationTruckId: null, updatedAt: serverTimestamp(),
  });
  await assertFails(updateDoc(palletRef, {
    markedForShipment: true, updatedAt: serverTimestamp(),
  }));
  await runTransaction(db, async (tx) => {
    const guardNow = await tx.get(guard);
    const palletNow = await tx.get(palletRef);
    if (!palletNow.exists()) throw new Error('test pallet missing');
    tx.update(palletRef, { markedForShipment: true, updatedAt: serverTimestamp() });
    tx.update(guard, {
      revision: guardNow.data().revision + 1,
      updatedAt: serverTimestamp(), updatedBy: uid,
    });
  });
  await assertFails(updateDoc(palletRef, { quantity: 12, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(palletRef, {
    zone: 'shipped', markedForShipment: false, updatedAt: serverTimestamp(),
  }));
  await runTransaction(db, async (tx) => {
    const guardNow = await tx.get(guard);
    const palletNow = await tx.get(palletRef);
    if (!palletNow.exists()) throw new Error('test pallet missing');
    tx.update(palletRef, {
      zone: 'shipped', markedForShipment: false,
      updatedAt: serverTimestamp(),
    });
    tx.update(guard, {
      revision: guardNow.data().revision + 1,
      updatedAt: serverTimestamp(), updatedBy: uid,
    });
  });
  await assertFails(updateDoc(palletRef, {
    quantity: 1, updatedAt: serverTimestamp(),
  }));
  console.log('PASS shipment pallet becomes immutable once shipped');
  // A physical truck ID is a one-time resource: two devices must not be
  // able to claim the same trip while their shipment queue view is stale.
  const claimPath = encodeURIComponent('2026-10-18|truck-a');
  const claim = doc(db, 'shipmentTripClaims', claimPath);
  const claimData = {
    plannedTruckId: 'truck-a', dispatchDate: '2026-10-19',
    shipmentNumber: 2501, createdAt: serverTimestamp(), createdBy: uid,
  };
  await setDoc(claim, claimData);
  await assertFails(setDoc(claim, { ...claimData, shipmentNumber: 2502 }));
  await assertFails(updateDoc(claim, { shipmentNumber: 2503 }));
  await assertFails(setDoc(doc(visitor, 'shipmentTripClaims', 'visitor'), {
    ...claimData, createdBy: 'unapproved',
  }));
  console.log('PASS physical trip claim is immutable and exclusive');

  // A shipment manifest must survive unchanged for batch traceability.
  // Operators may issue/reprint the original, not rewrite or delete stock,
  // batch, customer, physical trip identity or shipment quantities.
  const invoice = doc(db, 'shipments', '2504');
  await setDoc(invoice, {
    shipmentNumber: 2504, sourceType: 'manual', palletIds: [], totals: [],
    manualLines: [{ sku: 'IPA', description: 'IPA', quantity: 3 }],
    customerName: 'test customer', customerId: null, createdAt: serverTimestamp(),
  });
  await updateDoc(invoice, {
    originalIssuedAt: serverTimestamp(), originalIssuedBy: email,
  });
  await assertFails(updateDoc(invoice, {
    totals: [{ itemType: 'crates', beerStyle: 'IPA', totalQuantity: 42 }],
  }));
  await assertFails(updateDoc(invoice, { customerName: 'other' }));
  await assertFails(updateDoc(invoice, { plannedTruckId: 'truck-B' }));
  await assertFails(setDoc(doc(db, 'shipments', '2505'), {
    shipmentNumber: 2505, sourceType: 'pallets', palletIds: ['unguarded'],
    totals: [{ itemType: 'crates', beerStyle: 'IPA', totalQuantity: 84 }],
    createdAt: serverTimestamp(),
  }));
  console.log('PASS shipment manifest immutable and pallet dispatch requires marking guard');

  console.log('PASS all marking and shipment transitions require same-transaction guard');

} finally {
  await env.cleanup();
}
