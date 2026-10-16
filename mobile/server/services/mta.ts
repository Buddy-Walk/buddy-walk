import fs from "fs";
import path from "path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const MTA_FEEDS: Record<string, string> = {
  "1": "nyct%2Fgtfs", "2": "nyct%2Fgtfs", "3": "nyct%2Fgtfs", "4": "nyct%2Fgtfs", "5": "nyct%2Fgtfs", "6": "nyct%2Fgtfs",
  "A": "nyct%2Fgtfs-ace", "C": "nyct%2Fgtfs-ace", "E": "nyct%2Fgtfs-ace",
  "N": "nyct%2Fgtfs-nqrw", "Q": "nyct%2Fgtfs-nqrw", "R": "nyct%2Fgtfs-nqrw", "W": "nyct%2Fgtfs-nqrw",
  "B": "nyct%2Fgtfs-bdfm", "D": "nyct%2Fgtfs-bdfm", "F": "nyct%2Fgtfs-bdfm", "M": "nyct%2Fgtfs-bdfm",
  "L": "nyct%2Fgtfs-l",
  "G": "nyct%2Fgtfs-g",
  "J": "nyct%2Fgtfs-jz", "Z": "nyct%2Fgtfs-jz",
  "7": "nyct%2Fgtfs-7",
};

const MAX_STATION_KM = 2.5;
const MAX_ARRIVALS = 4;
/** Ignore scheduled trips far in the future — they are not useful "next train" answers. */
const MAX_ARRIVAL_MINUTES = 90;

interface Stop {
  name: string;
  lat: number;
  lon: number;
}

const parentStops = new Map<string, Stop>();

/**
 * Load parent subway stations from the bundled stops file, skipping malformed rows and logging
 * unavailable data.
 */
function loadStops() {
  try {
    const stopsPath = path.join(__dirname, "../stops.txt");
    const data = fs.readFileSync(stopsPath, "utf8");
    for (const line of data.split("\n").slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split(",");
      if (parts.length < 5 || parts[4] !== "1") continue;
      const stopId = parts[0];
      const stopLat = parseFloat(parts[2]);
      const stopLon = parseFloat(parts[3]);
      if (!stopId || Number.isNaN(stopLat) || Number.isNaN(stopLon)) continue;
      parentStops.set(stopId, { name: parts[1], lat: stopLat, lon: stopLon });
    }
    console.log(`[MTA] Loaded ${parentStops.size} parent stations.`);
  } catch (err) {
    console.error("[MTA] Error loading stops.txt:", err);
  }
}

/** Compute great-circle station distance in kilometers for nearby-station selection. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Remove the platform direction suffix so north/south GTFS stops map to their parent station. */
function baseStopId(stopId: string) {
  return stopId.replace(/[NS]$/, "");
}

/**
 * Normalize GTFS timestamp representations into Unix seconds, accommodating milliseconds, bigint,
 * strings, and protobuf Long values.
 */
export function epochSeconds(timeField: unknown): number | null {
  if (timeField == null) return null;
  if (typeof timeField === "number") {
    // GTFS-RT uses Unix seconds; guard against millisecond payloads.
    return timeField > 1e12 ? Math.floor(timeField / 1000) : timeField;
  }
  if (typeof timeField === "bigint") return Number(timeField);
  if (typeof timeField === "string") {
    const parsed = Number.parseInt(timeField, 10);
    return Number.isFinite(parsed) ? epochSeconds(parsed) : null;
  }
  const t = timeField as {
    toNumber?: () => number;
    toString?: () => string;
    low?: number;
    high?: number;
    seconds?: number | bigint | { low?: number; high?: number };
  };
  if (typeof t.toNumber === "function") return epochSeconds(t.toNumber());
  if (t.seconds != null) return epochSeconds(t.seconds);
  if (typeof t.toString === "function") {
    const parsed = Number.parseInt(t.toString(), 10);
    if (Number.isFinite(parsed) && parsed > 1e9) return epochSeconds(parsed);
  }
  if (t.low != null) {
    const high = t.high ?? 0;
    return epochSeconds(high * 0x100000000 + (t.low >>> 0));
  }
  return null;
}

/** Match a requested route to its feed label, including supported express or branch suffixes. */
function routeMatches(routeId: string, target: string) {
  const route = routeId.toUpperCase();
  if (route === target) return true;
  if ((route.endsWith("X") || route.endsWith("B")) && route.slice(0, -1) === target) return true;
  return false;
}

/** Format a nonnegative arrival countdown with natural singular/plural wording. */
function formatMinutesUntil(arrivalSec: number, nowSec: number) {
  const mins = Math.max(0, Math.round((arrivalSec - nowSec) / 60));
  if (mins <= 0) return "arriving now";
  if (mins === 1) return "in 1 minute";
  return `in ${mins} minutes`;
}

/** Minutes-only phrasing for TTS — clock times confused testers and the AI. */
function formatArrivalPhrase(arrivalSec: number, nowSec: number) {
  return formatMinutesUntil(arrivalSec, nowSec);
}

/** Find the nearest parent station inside the maximum walking-distance radius. */
function findNearestParentStop(lat: number, lon: number) {
  let best: { id: string; stop: Stop; km: number } | null = null;
  for (const [id, stop] of parentStops) {
    const km = haversineKm(lat, lon, stop.lat, stop.lon);
    if (km <= MAX_STATION_KM && (!best || km < best.km)) {
      best = { id, stop, km };
    }
  }
  return best;
}

loadStops();

/**
 * Fetch and decode the requested line's real-time feed, select arrivals at the nearest station,
 * and produce concise direction-aware arrival text.
 */
export async function getSubwayArrivals(routeId: string, userLat: number, userLon: number): Promise<string> {
  const route = routeId.toUpperCase().trim();
  const feedSuffix = MTA_FEEDS[route];
  if (!feedSuffix) {
    return `The train line "${route}" is not supported. Valid lines include 1–7, A, C, E, B, D, F, M, G, J, Z, L, N, Q, R, and W.`;
  }

  if (!userLat || !userLon) {
    return "Location is required to find the nearest subway station. Please enable location and try again.";
  }

  const nearest = findNearestParentStop(userLat, userLon);
  if (!nearest) {
    return "No subway stations found within walking distance of your location.";
  }

  const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedSuffix}`;
  const headers: Record<string, string> = {};
  if (process.env.MTA_API_KEY) {
    headers["x-api-key"] = process.env.MTA_API_KEY;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return "Could not connect to the MTA real-time feed right now. Please try again in a moment.";
  }

  const buffer = await response.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
  const nowSec = Math.floor(Date.now() / 1000);
  const stationId = nearest.id;
  const stationName = nearest.stop.name;

  const arrivals: { direction: string; arrivalSec: number; routeLabel: string }[] = [];

  for (const entity of feed.entity) {
    const trip = entity.tripUpdate;
    if (!trip?.trip?.routeId || !routeMatches(trip.trip.routeId, route)) continue;

    for (const stu of trip.stopTimeUpdate ?? []) {
      if (!stu.stopId || baseStopId(stu.stopId) !== stationId) continue;

      const arrivalSec = epochSeconds(stu.arrival?.time) ?? epochSeconds(stu.departure?.time);
      if (!arrivalSec || arrivalSec < nowSec - 30) continue;
      const minutesAhead = (arrivalSec - nowSec) / 60;
      if (minutesAhead > MAX_ARRIVAL_MINUTES) continue;

      const direction = stu.stopId.endsWith("N")
        ? "Uptown/Manhattan-bound"
        : stu.stopId.endsWith("S")
          ? "Downtown/Brooklyn-bound"
          : "Unknown direction";

      arrivals.push({
        direction,
        arrivalSec,
        routeLabel: trip.trip.routeId,
      });
    }
  }

  arrivals.sort(/* Order station arrivals chronologically before limiting the displayed departures. */ (a, b) => a.arrivalSec - b.arrivalSec);
  const upcoming = arrivals.slice(0, MAX_ARRIVALS);

  if (upcoming.length === 0) {
    return `No ${route} trains are expected at ${stationName}, your nearest station (${nearest.km.toFixed(1)} km away), in the next ${MAX_ARRIVAL_MINUTES} minutes.`;
  }

  const lines = upcoming.map((a) => {
    // Describe one arrival with its direction, branch/express label when different, and live
    // arrival phrase.
    const mins = formatArrivalPhrase(a.arrivalSec, nowSec);
    const express = a.routeLabel !== route ? ` (${a.routeLabel})` : "";
    return `${a.direction}${express}: ${mins}`;
  });

  return `Nearest station: ${stationName}. Upcoming ${route} trains: ${lines.join("; ")}.`;
}
