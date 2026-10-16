import { Request, Response } from "express";
import { TelemetryService } from "../services/telemetry";
import { aiRequestLogService } from "../services/aiRequestLog";
import { toCsv } from "../utils/csv";
import { buildDateFilter, isAdminAuthorized, parseLimit } from "../utils/adminAuth";

const telemetryService = new TelemetryService();

const EVENT_CSV_COLUMNS = [
  "serverTs",
  "clientTs",
  "installId",
  "sessionId",
  "name",
  "screen",
  "platform",
  "appVersion",
  "props",
];

const AI_REQUEST_CSV_COLUMNS = [
  "serverTs",
  "requestId",
  "installId",
  "sessionId",
  "platform",
  "appVersion",
  "feature",
  "toolUsed",
  "inputText",
  "outputText",
  "inputLength",
  "hasImage",
  "imageCount",
  "hasCoords",
  "success",
  "errorCode",
  "latencyMs",
  "outputLength",
  "tokenCount",
];

export class TelemetryController {
  /** Require installation and session identities before accepting a batch of usage events. */
  async recordEvents(req: Request, res: Response): Promise<void> {
    const body = req.body;
    if (!body || typeof body.installId !== "string" || typeof body.sessionId !== "string") {
      res.status(400).json({ error: "installId and sessionId are required" });
      return;
    }
    await telemetryService.recordEvents({ req, res }, body);
  }

  /** Require admin access before computing usage summaries over the requested date range. */
  async summary(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await telemetryService.summary({ req, res }, buildDateFilter(req));
  }

  /**
   * Require admin access and export bounded usage events with normalized dates and serialized
   * properties.
   */
  async exportCsv(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const limit = parseLimit(req, 5000, 50000);
    const { data } = await telemetryService.getEventsData(limit, buildDateFilter(req));
    const csv = toCsv(
      data.map(/* Convert an event document into a CSV row without losing its structured properties. */ (row) => ({
        ...row,
        serverTs: row.serverTs ? new Date(row.serverTs).toISOString() : "",
        clientTs: row.clientTs ?? "",
        props: row.props ? JSON.stringify(row.props) : "",
      })) as Record<string, unknown>[],
      EVENT_CSV_COLUMNS
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="telemetry_events.csv"');
    res.status(200).send(csv);
  }

  /** Require admin access and export bounded AI request records for the requested dates. */
  async exportAiRequestsCsv(req: Request, res: Response): Promise<void> {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const limit = parseLimit(req, 5000, 50000);
    const { data } = await aiRequestLogService.getData(limit, buildDateFilter(req));
    const csv = toCsv(
      data.map(/* Normalize request and response timestamps for the AI request CSV export. */ (row) => ({
        ...row,
        serverTs: row.serverTs ? new Date(row.serverTs).toISOString() : "",
      })) as Record<string, unknown>[],
      AI_REQUEST_CSV_COLUMNS
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="ai_requests.csv"');
    res.status(200).send(csv);
  }
}
