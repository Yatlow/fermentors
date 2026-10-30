/**
 * The achievement is a daily event, not a boolean copy of the currently
 * recalculated score. React refreshes, Firestore snapshots and transient score
 * changes must never replay a celebration that has already been acknowledged.
 */
export type SettledCellarScore = {
    day: string;
    score: number;
};

export type CellarCelebrationDecision = {
    shouldCelebrate: boolean;
    nextSettledScore: SettledCellarScore | null;
};

export function evaluateCellarCelebration(input: {
    score: number;
    analyzedDay: string | null;
    today: string;
    previousSettledScore: SettledCellarScore | null;
    persistedCompletionDay: string | null;
    locallyAcknowledgedDay: string | null;
    /** New scheduled work IDs since the last celebration permit a new cycle. */
    newScheduledWorkSinceAcknowledgement?: boolean;
    hasWorkRecordedToday: boolean;
    analyzing: boolean;
}): CellarCelebrationDecision {
    const {
        score, analyzedDay, today, previousSettledScore,
        persistedCompletionDay, locallyAcknowledgedDay, newScheduledWorkSinceAcknowledgement = false,
        hasWorkRecordedToday, analyzing,
    } = input;
    if (
        analyzing ||
        analyzedDay !== today ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 100
    ) {
        return { shouldCelebrate: false, nextSettledScore: previousSettledScore };
    }

    const previousTodayScore =
        previousSettledScore?.day === today ? previousSettledScore.score : null;
    const newAchievement = score === 100 &&
        (previousTodayScore === null
            // An already-completed round can load at 100 immediately after a
            // reload. Celebrate only if today's actual recorded work proves
            // this is a new day's achievement, not an empty/stale dashboard.
            ? hasWorkRecordedToday
            : previousTodayScore < 100);

    return {
        shouldCelebrate: newAchievement &&
            (newScheduledWorkSinceAcknowledgement ||
                (persistedCompletionDay !== today && locallyAcknowledgedDay !== today)),
        nextSettledScore: { day: today, score },
    };
}

/** One distinct marker shared by tabs and reloads, scoped to the local day. */
export const CELLAR_CELEBRATION_ACK_KEY = "fermentors-cellar-100-celebrated-day-v2";
