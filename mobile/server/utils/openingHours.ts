/**
 * Open/closed answers are computed here from Google's data, never by the
 * model: a blind user acting on a wrong "open now" can travel to a closed
 * store.
 */
export interface OpeningPeriodPoint {
  day: number;
  time: string;
}

export interface OpeningPeriod {
  open: OpeningPeriodPoint;
  close?: OpeningPeriodPoint;
}

export interface PlaceHoursInput {
  name: string;
  periods?: OpeningPeriod[];
  /** Google's weekday_text: Monday first. */
  weekdayText?: string[];
  /** Google's own open_now (accounts for holiday hours when current_opening_hours is used). */
  openNow?: boolean;
  utcOffsetMinutes?: number;
  businessStatus?: string;
}

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface LocalClock {
  day: number;
  minuteOfDay: number;
}

/**
 * Resolve the venue's local weekday and minute using its UTC offset, falling back to the New York
 * timezone when no offset is supplied.
 */
function localClock(now: Date, utcOffsetMinutes?: number): LocalClock {
  if (typeof utcOffsetMinutes === "number" && Number.isFinite(utcOffsetMinutes)) {
    const shifted = new Date(now.getTime() + utcOffsetMinutes * 60_000);
    return {
      day: shifted.getUTCDay(),
      minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  /** Read one formatted local-clock part, using an empty string when the formatter omitted it. */
  const get = (type: string) => parts.find(/* Locate the requested weekday, hour, or minute component in the timezone-aware formatter output. */ (part) => part.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    day: day < 0 ? now.getUTCDay() : day,
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Parse a four-digit Maps opening time into minutes after midnight, rejecting unsupported formats. */
function parseHhmm(time: string): number | null {
  const match = /^(\d{2})(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Normalize a minute-of-day value and format it as a spoken twelve-hour clock time. */
export function formatClockTime(minuteOfDay: number): string {
  const normalized = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

interface WeekInterval {
  start: number;
  end: number;
}

/**
 * Convert opening periods into week-relative intervals, handling overnight/week-wrap periods and
 * the always-open sentinel.
 */
function toIntervals(periods: OpeningPeriod[]): WeekInterval[] | "always" {
  if (
    periods.length === 1 &&
    !periods[0].close &&
    periods[0].open.day === 0 &&
    periods[0].open.time === "0000"
  ) {
    return "always";
  }
  const intervals: WeekInterval[] = [];
  for (const period of periods) {
    const openMinute = parseHhmm(period.open?.time ?? "");
    const closeMinute = period.close ? parseHhmm(period.close.time) : null;
    if (openMinute === null || closeMinute === null || !period.close) continue;
    const start = period.open.day * MINUTES_PER_DAY + openMinute;
    let end = period.close.day * MINUTES_PER_DAY + closeMinute;
    if (end <= start) end += MINUTES_PER_WEEK;
    intervals.push({ start, end });
  }
  return intervals;
}

/** Describes a minute-of-week relative to now: "today", "tomorrow", or the weekday. */
function relativeDay(targetMinuteOfWeek: number, now: LocalClock): string {
  const targetDay = Math.floor((targetMinuteOfWeek % MINUTES_PER_WEEK) / MINUTES_PER_DAY);
  const daysAhead = (targetDay - now.day + 7) % 7;
  if (daysAhead === 0) return "today";
  if (daysAhead === 1) return "tomorrow";
  return `on ${DAY_NAMES[targetDay]}`;
}

/**
 * One or two plain sentences, e.g. "Google Maps lists The UPS Store as closed
 * right now (it is 7:15 PM there). It opens tomorrow at 8:30 AM."
 * Returns null when Google gave no usable hours.
 */
export function describeOpeningStatus(input: PlaceHoursInput, now = new Date()): string | null {
  const name = input.name.trim() || "this place";
  if (input.businessStatus === "CLOSED_PERMANENTLY") {
    return `Google Maps lists ${name} as permanently closed.`;
  }
  if (input.businessStatus === "CLOSED_TEMPORARILY") {
    return `Google Maps lists ${name} as temporarily closed.`;
  }

  const clock = localClock(now, input.utcOffsetMinutes);
  const nowMinute = clock.day * MINUTES_PER_DAY + clock.minuteOfDay;
  const localTime = `it is ${formatClockTime(clock.minuteOfDay)} there`;
  const intervals = input.periods?.length ? toIntervals(input.periods) : [];

  if (intervals === "always") {
    return `Google Maps lists ${name} as open 24 hours.`;
  }

  const containing = intervals.find(
    /**
     * Check the current minute against an opening interval, including an interval carried across
     * the week boundary.
     */
    ({ start, end }) =>
      (nowMinute >= start && nowMinute < end) ||
      (nowMinute + MINUTES_PER_WEEK >= start && nowMinute + MINUTES_PER_WEEK < end)
  );
  const computedOpen = intervals.length > 0 ? Boolean(containing) : undefined;
  const openNow = input.openNow ?? computedOpen;
  if (openNow === undefined) return null;

  const todayIndex = (clock.day + 6) % 7;
  const todaysHours = input.weekdayText?.[todayIndex]?.trim();
  const hoursSentence = todaysHours ? ` Today's listed hours: ${todaysHours}.` : "";

  if (openNow) {
    // Google's open_now can disagree with the weekly periods on holidays;
    // only quote a closing time when the two sources agree.
    if (containing) {
      const closesAt = containing.end % MINUTES_PER_WEEK;
      return (
        `Google Maps lists ${name} as open right now (${localTime}). ` +
        `It closes ${relativeDay(closesAt, clock)} at ${formatClockTime(closesAt % MINUTES_PER_DAY)}.` +
        hoursSentence
      );
    }
    return `Google Maps lists ${name} as open right now (${localTime}).${hoursSentence}`;
  }

  const upcoming = intervals
    .map(/* Move each opening time to its next occurrence after the current local minute. */ ({ start }) => (start > nowMinute ? start : start + MINUTES_PER_WEEK))
    .sort(/* Sort upcoming opening times so the nearest occurrence can be reported. */ (a, b) => a - b)[0];
  const opensSentence =
    upcoming === undefined || containing
      ? ""
      : ` It opens ${relativeDay(upcoming, clock)} at ${formatClockTime(upcoming % MINUTES_PER_DAY)}.`;
  return `Google Maps lists ${name} as closed right now (${localTime}).${opensSentence}${hoursSentence}`;
}

/** Reads the hours fields from a legacy Place Details result. */
export function placeHoursFromDetails(details: any, fallbackName = ""): PlaceHoursInput {
  const current = details?.current_opening_hours;
  const regular = details?.opening_hours;
  const offset =
    typeof details?.utc_offset_minutes === "number"
      ? details.utc_offset_minutes
      : typeof details?.utc_offset === "number"
        ? details.utc_offset
        : undefined;
  return {
    name: details?.name || fallbackName,
    periods: (current?.periods ?? regular?.periods) as OpeningPeriod[] | undefined,
    weekdayText: (current?.weekday_text ?? regular?.weekday_text) as string[] | undefined,
    openNow:
      typeof current?.open_now === "boolean"
        ? current.open_now
        : typeof regular?.open_now === "boolean"
          ? regular.open_now
          : undefined,
    utcOffsetMinutes: offset,
    businessStatus: details?.business_status,
  };
}
