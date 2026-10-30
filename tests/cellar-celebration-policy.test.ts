import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
    CELLAR_CELEBRATION_ACK_KEY,
    evaluateCellarCelebration,
    type SettledCellarScore,
} from "../src/SERVICES/dashboard/cellarCelebrationPolicy";

const today = "2026-10-30";
const yesterday = "2026-10-29";

type Input = Parameters<typeof evaluateCellarCelebration>[0];
function decide(patch: Partial<Input> = {}) {
    return evaluateCellarCelebration({
        score: 100,
        today,
        analyzedDay: today,
        previousSettledScore: { day: today, score: 98 },
        locallyAcknowledgedDay: null,
        persistedCompletionDay: yesterday,
        hasWorkRecordedToday: true,
        analyzing: false,
        ...patch,
    });
}

test("an observed 99 -> 100 transition opens exactly one celebration", () => {
    let prior: SettledCellarScore | null = null;
    let acknowledged: string | null = null;
    for (const score of [60, 88, 99, 100, 100, 99, 100, 100]) {
        const result = decide({ score, previousSettledScore: prior, locallyAcknowledgedDay: acknowledged });
        prior = result.nextSettledScore;
        if (result.shouldCelebrate) {
            assert.equal(score, 100);
            assert.equal(acknowledged, null);
            acknowledged = today;
        }
    }
    assert.equal(acknowledged, today);
    assert.equal(decide({ previousSettledScore: prior, locallyAcknowledgedDay: acknowledged }).shouldCelebrate, false);
});

test("closing the modal and refreshing measurements cannot replay today's achievement", () => {
    const first = decide();
    assert.equal(first.shouldCelebrate, true);
    const afterClose = decide({
        previousSettledScore: { day: today, score: 99 },
        locallyAcknowledgedDay: today,
        persistedCompletionDay: yesterday,
    });
    assert.equal(afterClose.shouldCelebrate, false);
});

test("a persisted completion marker from this day blocks any replay across devices", () => {
    assert.equal(decide({ persistedCompletionDay: today }).shouldCelebrate, false);
    assert.equal(decide({ locallyAcknowledgedDay: today }).shouldCelebrate, false);
    assert.equal(decide({ persistedCompletionDay: today, locallyAcknowledgedDay: today }).shouldCelebrate, false);
});

test("yesterday's persistent 100 state does not hide a newly earned 100 today", () => {
    assert.equal(decide({ persistedCompletionDay: yesterday }).shouldCelebrate, true);
    assert.equal(decide({ persistedCompletionDay: null }).shouldCelebrate, true);
    // The legacy cellarHealthIs100 boolean is deliberately NOT an input.
});

test("initially loaded 100 from completed work today can celebrate once", () => {
    assert.equal(decide({ previousSettledScore: null, hasWorkRecordedToday: true }).shouldCelebrate, true);
    assert.equal(decide({
        previousSettledScore: null,
        hasWorkRecordedToday: true,
        persistedCompletionDay: today,
    }).shouldCelebrate, false);
});

test("an empty dashboard with an initial 100 does not invent an achievement", () => {
    assert.equal(decide({
        previousSettledScore: null,
        hasWorkRecordedToday: false,
    }).shouldCelebrate, false);
    assert.deepEqual(decide({
        previousSettledScore: null,
        hasWorkRecordedToday: false,
    }).nextSettledScore, { day: today, score: 100 });
});

test("a new day's first 100 can celebrate independently of yesterday", () => {
    assert.equal(decide({
        previousSettledScore: { day: yesterday, score: 100 },
        persistedCompletionDay: yesterday,
        hasWorkRecordedToday: true,
    }).shouldCelebrate, true);
    assert.equal(decide({
        previousSettledScore: { day: yesterday, score: 100 },
        persistedCompletionDay: today,
    }).shouldCelebrate, false);
});

test("an ordinary repeat rendering of an unchanged 100 never celebrates", () => {
    assert.equal(decide({ previousSettledScore: { day: today, score: 100 } }).shouldCelebrate, false);
});

test("an unfinished or stale yesterday analysis cannot celebrate", () => {
    const previous = { day: yesterday, score: 95 };
    const loading = decide({ analyzing: true, previousSettledScore: previous });
    assert.equal(loading.shouldCelebrate, false);
    assert.equal(loading.nextSettledScore, previous);
    const stale = decide({ analyzedDay: yesterday, previousSettledScore: previous });
    assert.equal(stale.shouldCelebrate, false);
    assert.equal(stale.nextSettledScore, previous);
    assert.equal(decide({ analyzedDay: null }).shouldCelebrate, false);
});

test("the 100 threshold must be exact; partial and invalid scores cannot celebrate", () => {
    for (const score of [0, 98, 99, 99.9, -1, 101, NaN, Infinity]) {
        assert.equal(decide({ score }).shouldCelebrate, false, `score ${score}`);
    }
});

test("a below-100 score must be settled before triggering a subsequent achievement", () => {
    const stale = decide({
        score: 99,
        analyzedDay: yesterday,
        previousSettledScore: { day: today, score: 100 },
    });
    assert.equal(stale.nextSettledScore?.score, 100);
    assert.equal(decide({ previousSettledScore: stale.nextSettledScore }).shouldCelebrate, false);
    assert.equal(decide({
        previousSettledScore: { day: today, score: 99 },
    }).shouldCelebrate, true);
});

test("component uses the daily marker, not Firestore status, to decide the animation", () => {
    const source = readFileSync("src/components/dashboard/HealthDashboard.tsx", "utf8");
    assert.match(source, /evaluateCellarCelebration\(\{/);
    assert.match(source, /locallyCelebratedDayRef\.current = today/);
    assert.match(source, /setItem\(CELLAR_CELEBRATION_ACK_KEY, today\)/);
    assert.match(source, /setCelebrationOpen\(true\)/);
    assert.match(source, /cellarHealthCompletedDay: today/);
    assert.match(source, /analyzedDay: localDateKey\(asOf\)/);
    assert.doesNotMatch(source, /shouldCelebrate\s*=\s*desiredIs100\s*&&\s*!persistedHealthIs100/);
    assert.ok(CELLAR_CELEBRATION_ACK_KEY.includes("cellar-100"));
});

test("status persistence remains separate and does not keep resetting its timer on unrelated tank snapshots", () => {
    const source = readFileSync("src/components/dashboard/HealthDashboard.tsx", "utf8");
    assert.match(source, /const desiredIs100 = healthScore === 100/);
    assert.match(source, /const timer = window\.setTimeout\(\(\) => \{/);
    assert.match(source, /cellarHealthIs100: desiredIs100/);
    assert.doesNotMatch(source, /persistedHealthWriteRef/);
});

test("closing and automatic timeout cannot be restarted by changing callback references", () => {
    const source = readFileSync("src/COMPONENTS/BeerCelebration.tsx", "utf8");
    assert.match(source, /latestOnClose\.current=onClose/);
    assert.match(source, /\},\[open,autoCloseMs\]\)/);
    assert.doesNotMatch(source, /\},\[open,onClose,autoCloseMs\]\)/);
    assert.match(source, /launchTimers\.forEach\(window\.clearTimeout\)/);
});
