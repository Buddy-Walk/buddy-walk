import { Request, Response } from "express";
import { lastMileTestLogService } from "../services/lastMileTestLog";
import { toCsv } from "../utils/csv";
import { buildDateFilter, isAdminAuthorized, parseLimit } from "../utils/adminAuth";
import { isMongoConnected } from "../database/usageStore";
import { toLastMileTestResponse, toLastMileTestSummaryResponse } from "../utils/lastMileTestRow";
import {
  ENTRANCE_CORRECTNESS,
  REVIEW_OUTCOMES,
  TURN_CORRECTNESS,
  type lastMileTestLogInterface,
} from "../database/models/lastMileTestLog";
import type { PlaceCandidateLog } from "../utils/nearbyPlaces";

const LAST_MILE_TEST_CSV_COLUMNS = [
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
  async list(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const limit = parseLimit(req, 25, 500);
    const dateFilter = buildDateFilter(req);
    if (req.query.includeImages === "true") {
      const { source, data } = await lastMileTestLogService.getData(limit, dateFilter);
      res.status(200).json({ source, data: data.map((row) => toLastMileTestResponse(row, true)) });
      return;
    }

    const { source, data } = await lastMileTestLogService.getSummaries(limit, dateFilter);
    const rows = data.map(({ placeCandidates, ...row }) => ({
      ...toLastMileTestSummaryResponse(row),
      // The candidate list is only needed in the detail view.
      placeCandidateCount: placeCandidates?.length ?? 0,
    }));
    res.status(200).json({ source, data: rows });
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
    res.status(200).json({
      source: isMongoConnected() ? "mongo" : "memory",
      data: toLastMileTestResponse(data, includeImages),
    });
  }

  async exportCsv(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const limit = parseLimit(req, 500, 5000);
    const dateFilter = buildDateFilter(req);
    const data: lastMileTestLogInterface[] =
      req.query.includeImages === "true"
        ? (await lastMileTestLogService.getData(limit, dateFilter)).data
        : (await lastMileTestLogService.getSummaries(limit, dateFilter)).data.map(
            toLastMileTestSummaryResponse
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
