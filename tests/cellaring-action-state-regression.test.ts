import test from "node:test";
import assert from "node:assert/strict";
import { hasCellarActionOnDate } from "../src/SERVICES/cellering/cellarActionState";

test("cellar action remains completed when a later same-day row has another note", () => {
    const rows = [
        { id: "2026-09-27_0915", notes: "כיוון פורק ל-1.4" },
        { id: "2026-09-27_1330", notes: "בדיקת גיזוז 2.45" },
    ];

    assert.equal(hasCellarActionOnDate(rows, "2026-09-27", ["כיוון פורק", "לכוון פורק"]), true);
});

test("cellar action completion never leaks from another day", () => {
    const rows = [
        { id: "2026-09-26_1745", notes: "כיוון פורק" },
        { id: "2026-09-27_0810", notes: "טמפ ולחץ" },
    ];

    assert.equal(hasCellarActionOnDate(rows, "2026-09-27", ["כיוון פורק", "לכוון פורק"]), false);
});

test("historical unpadded measurement times are still recognized", () => {
    assert.equal(
        hasCellarActionOnDate(
            [{ id: "2026-09-27_917", notes: "הורדת לחץ ל-0.7" }],
            "2026-09-27",
            ["הורדת לחץ", "העלאת לחץ"],
        ),
        true,
    );
});
