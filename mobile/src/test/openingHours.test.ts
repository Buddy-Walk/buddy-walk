import assert from "node:assert/strict";
import test from "node:test";
import {
  describeOpeningStatus,
  formatClockTime,
  placeHoursFromDetails,
} from "../../server/utils/openingHours";
import type { OpeningPeriod } from "../../server/utils/openingHours";

const WEEKDAY_TEXT = [
  "Monday: 8:30 AM – 7:00 PM",
  "Tuesday: 8:30 AM – 7:00 PM",
  "Wednesday: 8:30 AM – 7:00 PM",
  "Thursday: 8:30 AM – 7:00 PM",
  "Friday: 8:30 AM – 7:00 PM",
  "Saturday: 9:30 AM – 4:00 PM",
  "Sunday: Closed",
];

const UPS_PERIODS: OpeningPeriod[] = [
  ...[1, 2, 3, 4, 5].map(/* Create matching weekday opening periods for the business-hours fixture. */ (day) => ({
    open: { day, time: "0830" },
    close: { day, time: "1900" },
  })),
  { open: { day: 6, time: "0930" }, close: { day: 6, time: "1600" } },
];

const ups = {
  name: "The UPS Store",
  periods: UPS_PERIODS,
  weekdayText: WEEKDAY_TEXT,
  utcOffsetMinutes: -240,
};

test("formatClockTime renders 12-hour times", () => {
  // Regression test: formatClockTime renders 12-hour times.
  assert.equal(formatClockTime(0), "12:00 AM");
  assert.equal(formatClockTime(8 * 60 + 30), "8:30 AM");
  assert.equal(formatClockTime(19 * 60), "7:00 PM");
});

// Regression: 9/23 7:15 PM the app said the UPS Store was open until 6:30 PM.
test("describeOpeningStatus says closed after closing time with the next opening", () => {
  // Regression test: describeOpeningStatus says closed after closing time with the next opening.
  const wednesday715pm = new Date("2026-09-23T23:15:00Z");
  assert.equal(
    describeOpeningStatus(ups, wednesday715pm),
    "Google Maps lists The UPS Store as closed right now (it is 7:15 PM there). " +
      "It opens tomorrow at 8:30 AM. Today's listed hours: Wednesday: 8:30 AM – 7:00 PM."
  );
});

test("describeOpeningStatus gives the closing time while open", () => {
  // Regression test: describeOpeningStatus gives the closing time while open.
  const wednesday2pm = new Date("2026-09-23T18:00:00Z");
  assert.equal(
    describeOpeningStatus(ups, wednesday2pm),
    "Google Maps lists The UPS Store as open right now (it is 2:00 PM there). " +
      "It closes today at 7:00 PM. Today's listed hours: Wednesday: 8:30 AM – 7:00 PM."
  );
});

test("describeOpeningStatus skips closed days when finding the next opening", () => {
  // Regression test: describeOpeningStatus skips closed days when finding the next opening.
  const saturday5pm = new Date("2026-09-26T21:00:00Z");
  assert.match(
    describeOpeningStatus(ups, saturday5pm) ?? "",
    /closed right now \(it is 5:00 PM there\)\. It opens on Monday at 8:30 AM\./
  );
});

test("describeOpeningStatus prefers Google's open_now over the weekly periods", () => {
  // Regression test: describeOpeningStatus prefers Google's open_now over the weekly periods.
  const wednesday2pm = new Date("2026-09-23T18:00:00Z");
  assert.match(
    describeOpeningStatus({ ...ups, openNow: false }, wednesday2pm) ?? "",
    /^Google Maps lists The UPS Store as closed right now \(it is 2:00 PM there\)\. Today's/
  );
});

test("describeOpeningStatus handles overnight hours, 24-hour places and closures", () => {
  // Regression test: describeOpeningStatus handles overnight hours, 24-hour places and closures.
  const overnight = {
    name: "Late Diner",
    periods: [{ open: { day: 5, time: "1800" }, close: { day: 6, time: "0200" } }],
    utcOffsetMinutes: -240,
  };
  assert.match(
    describeOpeningStatus(overnight, new Date("2026-09-26T05:00:00Z")) ?? "",
    /open right now \(it is 1:00 AM there\)\. It closes today at 2:00 AM\./
  );
  assert.equal(
    describeOpeningStatus({ name: "Duane Reade", periods: [{ open: { day: 0, time: "0000" } }] }),
    "Google Maps lists Duane Reade as open 24 hours."
  );
  assert.equal(
    describeOpeningStatus({ name: "Old Shop", businessStatus: "CLOSED_PERMANENTLY" }),
    "Google Maps lists Old Shop as permanently closed."
  );
  assert.equal(describeOpeningStatus({ name: "No Hours" }), null);
});

test("describeOpeningStatus falls back to New York time without a UTC offset", () => {
  // Regression test: describeOpeningStatus falls back to New York time without a UTC offset.
  const withoutOffset = { name: ups.name, periods: ups.periods, weekdayText: ups.weekdayText };
  assert.match(
    describeOpeningStatus(withoutOffset, new Date("2026-09-23T23:15:00Z")) ?? "",
    /it is 7:15 PM there/
  );
});

test("placeHoursFromDetails reads current hours, offset and status", () => {
  // Regression test: placeHoursFromDetails reads current hours, offset and status.
  const input = placeHoursFromDetails(
    {
      name: "The UPS Store",
      business_status: "OPERATIONAL",
      utc_offset: -240,
      current_opening_hours: { open_now: false, periods: UPS_PERIODS, weekday_text: WEEKDAY_TEXT },
      opening_hours: { open_now: true },
    },
    "fallback"
  );
  assert.equal(input.name, "The UPS Store");
  assert.equal(input.openNow, false);
  assert.equal(input.utcOffsetMinutes, -240);
  assert.equal(input.periods?.length, UPS_PERIODS.length);
  assert.equal(input.businessStatus, "OPERATIONAL");
  assert.equal(placeHoursFromDetails(undefined, "Fallback").name, "Fallback");
});
