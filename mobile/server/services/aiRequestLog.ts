import aiRequestLogModel, { aiRequestLogInterface } from "../database/models/aiRequestLog";
import {
  isMongoConnected,
  memoryAiRequests,
  pushMemoryAiRequest,
} from "../database/usageStore";

export interface AiRequestLogInput {
  requestId?: string;
  installId?: string;
  sessionId?: string;
  platform?: string;
  appVersion?: string;
  feature?: string;
  toolUsed?: string;
  inputLength: number;
  inputText?: string;
  outputText?: string;
  hasImage?: boolean;
  imageCount?: number;
  hasCoords?: boolean;
  success: boolean;
  errorCode?: string;
  latencyMs: number;
  outputLength?: number;
  tokenCount?: number;
}

export class AiRequestLogService {
  /**
   * Normalize request metadata and save it to Mongo or bounded memory; logging failures must not
   * fail the user's request.
   */
  async record(input: AiRequestLogInput): Promise<void> {
    const doc: aiRequestLogInterface = {
      ...input,
      hasImage: !!input.hasImage,
      imageCount: input.imageCount ?? 0,
      hasCoords: !!input.hasCoords,
      serverTs: new Date(),
    };
    try {
      if (isMongoConnected()) {
        await aiRequestLogModel.create(doc);
      } else {
        pushMemoryAiRequest(doc);
      }
    } catch (e) {
      console.error("[AiRequestLogService] record failed:", e);
    }
  }

  /**
   * Return newest-first AI request records with a limit and optional inclusive date bounds from
   * the active store.
   */
  async getData(
    limit: number,
    dateFilter?: Record<string, unknown>
  ): Promise<{ source: string; data: aiRequestLogInterface[] }> {
    if (isMongoConnected()) {
      const data = await aiRequestLogModel
        .find(dateFilter ?? {})
        .sort({ serverTs: -1 })
        .limit(limit)
        .lean();
      return { source: "mongo", data };
    }
    let rows = [...memoryAiRequests].reverse();
    if (dateFilter?.serverTs) {
      const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
      rows = rows.filter((row) => {
        // Apply the requested server timestamp range to an in-memory request record.
        const ts = new Date(row.serverTs).getTime();
        if (range.$gte && ts < range.$gte.getTime()) return false;
        if (range.$lte && ts > range.$lte.getTime()) return false;
        return true;
      });
    }
    return { source: "memory", data: rows.slice(0, limit) };
  }

  /**
   * Aggregate request totals, success rate, latency, features, and tools consistently across Mongo
   * and fallback memory.
   */
  async summary(dateFilter?: Record<string, unknown>) {
    if (isMongoConnected()) {
      const match = dateFilter ?? {};
      const byFeature = await aiRequestLogModel.aggregate([
        { $match: match },
        { $group: { _id: "$feature", count: { $sum: 1 }, avgLatency: { $avg: "$latencyMs" } } },
        { $sort: { count: -1 } },
      ]);
      const byTool = await aiRequestLogModel.aggregate([
        { $match: match },
        { $group: { _id: "$toolUsed", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);
      const totals = await aiRequestLogModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            success: { $sum: { $cond: ["$success", 1, 0] } },
            avgLatency: { $avg: "$latencyMs" },
          },
        },
      ]);
      const t = totals[0] ?? { total: 0, success: 0, avgLatency: 0 };
      return {
        source: "mongo",
        totalRequests: t.total,
        successRate: t.total ? Math.round((t.success / t.total) * 100) : 0,
        avgLatencyMs: Math.round(t.avgLatency ?? 0),
        byFeature: byFeature.map(/* Normalize one Mongo feature aggregate and round its average latency for reporting. */ (r: any) => ({
          feature: r._id || "unknown",
          count: r.count,
          avgLatencyMs: Math.round(r.avgLatency ?? 0),
        })),
        byTool: byTool.map(/* Normalize one Mongo tool aggregate, labeling missing tools explicitly. */ (r: any) => ({ tool: r._id || "none", count: r.count })),
      };
    }

    let rows = memoryAiRequests;
    if (dateFilter?.serverTs) {
      const range = dateFilter.serverTs as { $gte?: Date; $lte?: Date };
      rows = rows.filter((row) => {
        // Restrict in-memory request-summary input to the requested timestamp range.
        const ts = new Date(row.serverTs).getTime();
        if (range.$gte && ts < range.$gte.getTime()) return false;
        if (range.$lte && ts > range.$lte.getTime()) return false;
        return true;
      });
    }
    const featureCounts = new Map<string, { count: number; latency: number }>();
    const toolCounts = new Map<string, number>();
    let success = 0;
    let latencySum = 0;
    for (const row of rows) {
      if (row.success) success += 1;
      latencySum += row.latencyMs;
      const f = row.feature || "unknown";
      const cur = featureCounts.get(f) ?? { count: 0, latency: 0 };
      cur.count += 1;
      cur.latency += row.latencyMs;
      featureCounts.set(f, cur);
      const tool = row.toolUsed || "none";
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
    return {
      source: "memory",
      totalRequests: rows.length,
      successRate: rows.length ? Math.round((success / rows.length) * 100) : 0,
      avgLatencyMs: rows.length ? Math.round(latencySum / rows.length) : 0,
      byFeature: [...featureCounts.entries()]
        .map(/* Convert an in-memory feature accumulator into its count and mean-latency report. */ ([feature, v]) => ({
          feature,
          count: v.count,
          avgLatencyMs: Math.round(v.latency / v.count),
        }))
        .sort(/* Show the most frequently requested features first. */ (a, b) => b.count - a.count),
      byTool: [...toolCounts.entries()]
        .map(/* Convert a tool-count map entry into the summary response shape. */ ([tool, count]) => ({ tool, count }))
        .sort(/* Show the most frequently used tools first. */ (a, b) => b.count - a.count),
    };
  }
}

export const aiRequestLogService = new AiRequestLogService();
