import telemetryEventModel, {
  telemetryEventInterface,
} from "../database/models/telemetryEvent";
import {
  isMongoConnected,
  memoryEvents,
  pushMemoryEvents,
} from "../database/usageStore";
import { AppContext } from "../types";
import { aiRequestLogService } from "./aiRequestLog";

interface IncomingEvent {
  name: string;
  props?: Record<string, unknown>;
  screen?: string;
  ts?: number;
}

interface EventBatch {
  installId: string;
  sessionId: string;
  platform?: string;
  appVersion?: string;
  events: IncomingEvent[];
}

const MAX_EVENTS_PER_BATCH = 200;

/**
 * Read an event's explicit feature label, falling back to unknown for missing or unusable
 * properties.
 */
function featureFromProps(props?: Record<string, unknown>): string {
  if (props && typeof props.feature === "string" && props.feature) return props.feature;
  return "unknown";
}

export class TelemetryService {
  /**
   * Bound and validate the event batch, add installation/session/server metadata, and persist
   * accepted events in the active store.
   */
  async recordEvents(ctx: AppContext, body: EventBatch) {
    const { res } = ctx;
    try {
      const events = Array.isArray(body.events)
        ? body.events.slice(0, MAX_EVENTS_PER_BATCH)
        : [];

      const docs: telemetryEventInterface[] = events
        .filter(/* Ignore null or unnamed events before preparing telemetry documents. */ (e) => e && typeof e.name === "string" && e.name.length > 0)
        .map(/* Attach batch identity, platform, version, and server receipt time to one valid client event. */ (e) => ({
          installId: body.installId,
          sessionId: body.sessionId,
          name: e.name,
          props: e.props,
          screen: e.screen,
          platform: body.platform,
          appVersion: body.appVersion,
          clientTs: typeof e.ts === "number" ? e.ts : undefined,
          serverTs: new Date(),
        }));

      if (docs.length === 0) {
        res.status(200).json({ accepted: 0 });
        return;
      }

      if (isMongoConnected()) {
        await telemetryEventModel.insertMany(docs, { ordered: false });
      } else {
        pushMemoryEvents(docs);
      }

      res.status(200).json({ accepted: docs.length });
    } catch (e: any) {
      console.error("[TelemetryService] Error in recordEvents:", e);
      res.status(500).json({
        code: 500,
        message: e.message || "Internal Server Error",
      });
    }
  }

  /** Returns recent raw events (newest first) for listing/export. */
  async getEventsData(
    limit: number,
    dateFilter?: Record<string, unknown>
  ): Promise<{ source: string; data: any[] }> {
    if (isMongoConnected()) {
      const data = await telemetryEventModel
        .find(dateFilter ?? {})
        .sort({ serverTs: -1 })
        .limit(limit)
        .lean();
      return { source: "mongo", data };
    }
    let rows = [...memoryEvents].reverse();
    if (dateFilter?.serverTs) {
      const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
      rows = rows.filter((row) => {
        // Apply inclusive server-time bounds to a fallback telemetry event.
        const ts = new Date(row.serverTs).getTime();
        if (range.$gte && ts < range.$gte.getTime()) return false;
        if (range.$lte && ts > range.$lte.getTime()) return false;
        return true;
      });
    }
    return { source: "memory", data: rows.slice(0, limit) };
  }

  /**
   * Combine event counts, unique installations, feature usage, answer latency, and AI request
   * statistics for an admin summary.
   */
  async summary(ctx: AppContext, dateFilter?: Record<string, unknown>) {
    const { res } = ctx;
    try {
      const aiSummary = await aiRequestLogService.summary(dateFilter);

      if (isMongoConnected()) {
        const match = dateFilter ?? {};
        const byEvent = await telemetryEventModel.aggregate([
          { $match: match },
          { $group: { _id: "$name", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]);
        const byFeature = await telemetryEventModel.aggregate([
          { $match: { ...match, name: { $in: ["question_asked", "answer_received", "answer_failed"] } } },
          { $group: { _id: "$props.feature", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]);
        const answerLatency = await telemetryEventModel.aggregate([
          { $match: { ...match, name: "answer_received", "props.latencyMs": { $type: "number" } } },
          {
            $group: {
              _id: null,
              avgLatencyMs: { $avg: "$props.latencyMs" },
              count: { $sum: 1 },
            },
          },
        ]);
        const installIds = await telemetryEventModel.distinct("installId", match);
        const totalEvents = await telemetryEventModel.countDocuments(match);
        res.status(200).json({
          source: "mongo",
          totalEvents,
          uniqueInstalls: installIds.length,
          byEvent: byEvent.map(/* Normalize a Mongo event-count group into the public summary shape. */ (row: any) => ({ name: row._id, count: row.count })),
          byFeature: byFeature.map(/* Normalize a Mongo feature group, explicitly labeling a missing feature. */ (row: any) => ({
            feature: row._id || "unknown",
            count: row.count,
          })),
          answerMetrics: {
            count: answerLatency[0]?.count ?? 0,
            avgLatencyMs: Math.round(answerLatency[0]?.avgLatencyMs ?? 0),
          },
          aiRequests: aiSummary,
        });
        return;
      }

      const counts = new Map<string, number>();
      const featureCounts = new Map<string, number>();
      const installs = new Set<string>();
      let answerCount = 0;
      let answerLatencySum = 0;

      let rows = memoryEvents;
      if (dateFilter?.serverTs) {
        const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
        rows = rows.filter((row) => {
          // Restrict fallback summary events to the requested server-time range.
          const ts = new Date(row.serverTs).getTime();
          if (range.$gte && ts < range.$gte.getTime()) return false;
          if (range.$lte && ts > range.$lte.getTime()) return false;
          return true;
        });
      }

      for (const e of rows) {
        counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
        installs.add(e.installId);
        if (["question_asked", "answer_received", "answer_failed"].includes(e.name)) {
          const f = featureFromProps(e.props as Record<string, unknown> | undefined);
          featureCounts.set(f, (featureCounts.get(f) ?? 0) + 1);
        }
        if (e.name === "answer_received" && typeof e.props?.latencyMs === "number") {
          answerCount += 1;
          answerLatencySum += e.props.latencyMs as number;
        }
      }

      const byEvent = [...counts.entries()]
        .map(/* Convert an event-count map entry into the summary response shape. */ ([name, count]) => ({ name, count }))
        .sort(/* Show the most frequent event names first. */ (a, b) => b.count - a.count);

      res.status(200).json({
        source: "memory",
        totalEvents: rows.length,
        uniqueInstalls: installs.size,
        byEvent,
        byFeature: [...featureCounts.entries()]
          .map(/* Convert a feature-count map entry into the summary response shape. */ ([feature, count]) => ({ feature, count }))
          .sort(/* Show the most frequently used features first. */ (a, b) => b.count - a.count),
        answerMetrics: {
          count: answerCount,
          avgLatencyMs: answerCount ? Math.round(answerLatencySum / answerCount) : 0,
        },
        aiRequests: aiSummary,
      });
    } catch (e: any) {
      console.error("[TelemetryService] Error in summary:", e);
      res.status(500).json({
        code: 500,
        message: e.message || "Internal Server Error",
      });
    }
  }
}
