import { Request, Response } from "express";
import { lastMileTestLogService } from "../services/lastMileTestLog";
import { toCsv } from "../utils/csv";
import { buildDateFilter, isAdminAuthorized, parseLimit } from "../utils/adminAuth";
import { isMongoConnected } from "../database/usageStore";
import {
  rowId,
  toLastMileTestResponse,
  toLastMileTestSummaryResponse,
  toRetryHistoryEntry,
} from "../utils/lastMileTestRow";
import {
  ENTRANCE_CORRECTNESS,
  RETRY_PANORAMA_MODES,
  REVIEW_OUTCOMES,
  TURN_CORRECTNESS,
  type lastMileTestLogInterface,
} from "../database/models/lastMileTestLog";
import type { PlaceCandidateLog } from "../utils/nearbyPlaces";
import { assessReplay, type ReplayableLog } from "../utils/lastMileReplay";
import { summarizeFieldEvaluation } from "../utils/lastMileEvaluation";
import {
  findOriginal,
  LastMileRetryError,
  retryAvailability,
  retryLastMileTest,
  UNEXPECTED_RETRY_FAILURE,
} from "../services/lastMileRetry";
import { lastMileRetryRunService, type RetryRun } from "../services/lastMileRetryRuns";
import { parseIdempotencyKey } from "../utils/idempotencyKey";

const LAST_MILE_TEST_CSV_COLUMNS = [
  "pipelineVersion", "deployedCommit", "runKind", "retryOf", "retryPanoramaMode", "retryDefaultsApplied", "replayInput", "safetyReasons", "walkingEvidence", "panoramaTargetHeading", "confidenceMethod",
  "serverTs",
  "destination",
  "destinationQuery",
  "lat",
  "lng",
  "panoramaDate",
  "panoramaStatus",
  "panoramaValidation",
  "panoramaSource",
  "panoId",
  "panoramaCopyright",
  "panoramaAgeYears",
  "destinationPhotoDate",
  "destinationPhotoStatus",
  "destinationPlaceName",
  "destinationPlaceAddress",
  "destinationTypes",
  "destinationDistanceMeters",
  "destinationOpenNow",
  "destinationBusinessStatus",
  "placesSearches",
  "placeCandidates",
  "entranceSource",
  "entranceLat",
  "entranceLng",
  "besideBuilding",
  "gpsAccuracyMeters",
  "gpsAllowanceMeters",
  "exactGateWidened",
  "compassAccuracyLevel",
  "destinationBearing",
  "deviceHeading",
  "headingDifferenceDegrees",
  "headingAligned",
  "compassHeading",
  "panoramaMatchedHeading",
  "headingComparisonDifference",
  "headingComparisonAgrees",
  "confidenceScore",
  "confidenceLevel",
  "confidenceReasons",
  "destinationReferenceUsed",
  "signText",
  "signTextMatched",
  "navigationMode",
  "testScenario",
  "currentHeading",
  "targetHeading",
  "turnInstruction",
  "finalOutput",
  "dataSources",
  "reviewOutcome",
  "turnCorrectness",
  "entranceCorrectness",
  "reviewerStatus",
  "reviewerNotes",
  "reviewedAt",
  "success",
  "error",
  "latencyMs",
  "panoramaHeadings",
  "steps",
  "userPhoto",
  "panoramaPhoto",
  "destinationPhoto",
];

function describeCandidatesForCsv(candidates?: PlaceCandidateLog[]): string {
  return (candidates ?? [])
    .map(
      (candidate) =>
        `${candidate.name} (${candidate.address}) ${candidate.distanceMeters} m ` +
        `${candidate.relevant ? "kept" : "rejected"} via ${candidate.source}`
    )
    .join(" | ");
}

/** The replay assessment the dashboard needs, without the input to run. */
function replaySummary(original: ReplayableLog | null) {
  if (!original) {
    return {
      status: "not_replayable" as const,
      reason: "The original test this retry belongs to no longer exists.",
      defaultsApplied: [],
      originalPanorama: { available: false, reason: "The original test no longer exists." },
    };
  }
  const { input, ...summary } = assessReplay(original);
  return summary;
}

/** A retry in flight, so other tabs and reloads show it as running. */
function runningRetryOf(run: RetryRun | undefined) {
  return run ? { panoramaMode: run.panoramaMode, startedAt: new Date(run.startedAt).getTime() } : null;
}

/**
 * Retry facts for each row of a list page. A retry is assessed through its
 * original, which may be off the page.
 */
async function retryFacts<T extends ReplayableLog & { retryOf?: string }>(rows: T[]) {
  const originals = new Map<string, ReplayableLog>(rows.map((row) => [rowId(row), row]));
  const missing = rows
    .map((row) => row.retryOf)
    .filter((id): id is string => Boolean(id) && !originals.has(id!));
  // Independent queries, so they run together.
  const [offPageOriginals, retryCounts, running] = await Promise.all([
    lastMileTestLogService.getSummariesByIds(missing),
    lastMileTestLogService.countRetries(rows.filter((row) => !row.retryOf).map(rowId)),
    lastMileRetryRunService.running(rows.map((row) => row.retryOf ?? rowId(row))),
  ]);
  offPageOriginals.forEach((row) => originals.set(rowId(row), row));
  return (row: T) => ({
    retryCount: retryCounts.get(rowId(row)) ?? 0,
    replay: replaySummary(originals.get(row.retryOf ?? rowId(row)) ?? null),
    runningRetry: runningRetryOf(running.get(row.retryOf ?? rowId(row))),
  });
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): { ok: true; value?: T } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true };
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? { ok: true, value: value as T }
    : { ok: false };
}

export class LastMileTestLogController {
  async evaluation(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const limit = parseLimit(req, 1000, 5000);
      const dateFilter = buildDateFilter(req);
      // The limit applies to field tests only; retries are counted separately
      // so they never take a field test's place in the sample.
      const [{ data }, replayCount] = await Promise.all([
        lastMileTestLogService.getSummaries(limit, dateFilter),
        lastMileTestLogService.countRetriesInRange(dateFilter),
      ]);
      res.json({ ...summarizeFieldEvaluation(data), replayCount, sampledTrials: data.length, limit, potentiallyTruncated: data.length === limit });
    } catch {
      console.error("[last-mile-tests] Evaluation query failed");
      res.status(503).json({ error: "Evaluation data is temporarily unavailable." });
    }
  }

  async retry(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const idempotencyKey = parseIdempotencyKey(req.headers?.["idempotency-key"]);
    if (!idempotencyKey) {
      res.status(400).json({
        error: "Send an Idempotency-Key header with a new UUIDv7 for each retry.",
        code: "idempotency_key_required",
      });
      return;
    }

    const panoramaMode = optionalEnum(req.body?.panoramaMode, RETRY_PANORAMA_MODES);
    if (!panoramaMode.ok) {
      res.status(400).json({
        error: `panoramaMode must be ${RETRY_PANORAMA_MODES.join(" or ")}`,
      });
      return;
    }

    try {
      const { testLogId, log, defaultsApplied, replayed } = await retryLastMileTest({
        id: req.params.id,
        panoramaMode: panoramaMode.value ?? "fresh",
        idempotencyKey,
      });
      if (replayed) res.setHeader("Idempotent-Replayed", "true");
      res.status(201).json({
        testLogId,
        defaultsApplied,
        replayed,
        data: log ? toLastMileTestResponse(log, false) : null,
      });
    } catch (error) {
      if (error instanceof LastMileRetryError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      console.error("[LastMileTestLog] retry failed:", error);
      res.status(500).json({ error: UNEXPECTED_RETRY_FAILURE });
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const limit = parseLimit(req, 25, 500);
    const dateFilter = buildDateFilter(req);
    const includeRetries = req.query.includeRetries === "true";
    if (req.query.includeImages === "true") {
      const { source, data } = await lastMileTestLogService.getData(limit, dateFilter, includeRetries);
      const factsOf = await retryFacts(data);
      res.status(200).json({
        source,
        retry: retryAvailability(),
        data: data.map((row) => ({ ...toLastMileTestResponse(row, true), ...factsOf(row) })),
      });
      return;
    }

    const { source, data } = await lastMileTestLogService.getSummaries(limit, dateFilter, includeRetries);
    const factsOf = await retryFacts(data);
    const rows = data.map((summary) => {
      const { placeCandidates, userPhotoReplayable, ...row } = summary;
      return {
        ...toLastMileTestSummaryResponse(row),
        ...factsOf(summary),
        // The candidate list is only needed in the detail view.
        placeCandidateCount: placeCandidates?.length ?? 0,
      };
    });
    res.status(200).json({ source, retry: retryAvailability(), data: rows });
  }

  async getOne(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const includeStreetView = req.query.includeStreetView === "true";
    const data = await lastMileTestLogService.getById(req.params.id, {
      includeStreetView,
    });
    if (!data) {
      res.status(404).json({ error: "Last Meters test log not found" });
      return;
    }

    const includeImages = req.query.includeImages === "true";
    const { originalId, original } = await findOriginal(data);
    const [retries, running] = await Promise.all([
      original ? lastMileTestLogService.getRetries(originalId) : [],
      lastMileRetryRunService.running([originalId]),
    ]);
    res.status(200).json({
      source: isMongoConnected() ? "mongo" : "memory",
      retry: retryAvailability(),
      data: {
        ...toLastMileTestResponse(data, includeImages, includeStreetView),
        replay: replaySummary(original),
        history: {
          originalId,
          original: original ? toRetryHistoryEntry(original) : null,
          retries: retries.map(toRetryHistoryEntry),
          runningRetry: runningRetryOf(running.get(originalId)),
        },
      },
    });
  }

  async exportCsv(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const limit = parseLimit(req, 500, 5000);
    const dateFilter = buildDateFilter(req);
    const includeRetries = req.query.includeRetries === "true";
    const data: lastMileTestLogInterface[] =
      req.query.includeImages === "true"
        ? (await lastMileTestLogService.getData(limit, dateFilter, includeRetries)).data
        : (await lastMileTestLogService.getSummaries(limit, dateFilter, includeRetries)).data.map(
            ({ userPhotoReplayable, ...row }) => toLastMileTestSummaryResponse(row)
          );
    const csv = toCsv(
      data.map((row) => ({
        ...row,
        serverTs: row.serverTs ? new Date(row.serverTs).toISOString() : "",
        reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : "",
        panoramaHeadings: row.panoramaHeadings.join("|"),
        panoramaValidation: JSON.stringify(row.panoramaValidation || []),
        destinationTypes: (row.destinationTypes || []).join("|"),
        confidenceReasons: (row.confidenceReasons || []).join("|"),
        placesSearches: (row.placesSearches || []).join("+"),
        placeCandidates: describeCandidatesForCsv(row.placeCandidates),
        dataSources: (row.dataSources || []).join("|"),
        steps: JSON.stringify(row.steps),
        retryDefaultsApplied: (row.retryDefaultsApplied || []).join("|"),
        replayInput: JSON.stringify(row.replayInput || null),
        safetyReasons: JSON.stringify(row.safetyReasons || []),
        walkingEvidence: JSON.stringify(row.walkingEvidence || null),
      })) as Record<string, unknown>[],
      LAST_MILE_TEST_CSV_COLUMNS
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="last_mile_tests.csv"');
    res.status(200).send(csv);
  }

  async updateReview(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const status = req.body?.reviewerStatus;
    if (
      status !== undefined &&
      !["untested", "pass", "partial", "fail"].includes(status)
    ) {
      res.status(400).json({ error: "reviewerStatus must be untested, pass, partial, or fail" });
      return;
    }

    const reviewOutcome = optionalEnum(req.body?.reviewOutcome, REVIEW_OUTCOMES);
    const turnCorrectness = optionalEnum(req.body?.turnCorrectness, TURN_CORRECTNESS);
    const entranceCorrectness = optionalEnum(req.body?.entranceCorrectness, ENTRANCE_CORRECTNESS);
    if (!reviewOutcome.ok || !turnCorrectness.ok || !entranceCorrectness.ok) {
      res.status(400).json({
        error:
          `reviewOutcome must be ${REVIEW_OUTCOMES.join(", ")}; ` +
          `turnCorrectness must be ${TURN_CORRECTNESS.join(", ")}; ` +
          `entranceCorrectness must be ${ENTRANCE_CORRECTNESS.join(", ")}`,
      });
      return;
    }

    const reviewerNotes =
      typeof req.body?.reviewerNotes === "string"
        ? req.body.reviewerNotes.slice(0, 4000)
        : "";

    const { source, data } = await lastMileTestLogService.updateReview(req.params.id, {
      reviewerStatus: status,
      reviewerNotes,
      reviewOutcome: reviewOutcome.value,
      turnCorrectness: turnCorrectness.value,
      entranceCorrectness: entranceCorrectness.value,
    });
    if (!data) {
      res.status(404).json({ error: "Last Meters test log not found" });
      return;
    }
    res.status(200).json({ source, data });
  }
}
