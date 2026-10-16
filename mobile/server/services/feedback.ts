import feedbackModel, { feedbackInterface } from "../database/models/feedback";
import {
  isMongoConnected,
  memoryFeedback,
  pushMemoryFeedback,
} from "../database/usageStore";
import { AppContext } from "../types";

interface FeedbackBody {
  installId: string;
  sessionId?: string;
  type?: feedbackInterface["type"];
  rating?: number;
  message?: string;
  context?: Record<string, unknown>;
  platform?: string;
  appVersion?: string;
}

export class FeedbackService {
  /**
   * Normalize and bound feedback text, stamp receipt time, and store the record in Mongo or
   * fallback memory.
   */
  async create(ctx: AppContext, body: FeedbackBody) {
    const { res } = ctx;
    try {
      const entry: feedbackInterface = {
        installId: body.installId,
        sessionId: body.sessionId,
        type: body.type ?? "general",
        rating: typeof body.rating === "number" ? body.rating : undefined,
        message: typeof body.message === "string" ? body.message.slice(0, 4000) : undefined,
        context: body.context,
        platform: body.platform,
        appVersion: body.appVersion,
        date: new Date(),
      };

      if (isMongoConnected()) {
        const result = await feedbackModel.create(entry);
        res.status(200).json({ message: "Feedback received", data: result });
      } else {
        pushMemoryFeedback(entry);
        res.status(200).json({ message: "Feedback received (memory)", data: entry });
      }
    } catch (e: any) {
      console.error("[FeedbackService] Error in create:", e);
      res.status(500).json({
        code: 500,
        message: e.message || "Internal Server Error",
      });
    }
  }

  /** Returns recent feedback (newest first) for listing/export. */
  async getFeedbackData(
    limit: number,
    dateFilter?: Record<string, unknown>
  ): Promise<{ source: string; data: any[] }> {
    if (isMongoConnected()) {
      const data = await feedbackModel
        .find(dateFilter ?? {})
        .sort({ date: -1 })
        .limit(limit)
        .lean();
      return { source: "mongo", data };
    }
    let rows = [...memoryFeedback].reverse();
    if (dateFilter?.date) {
      const range = dateFilter.date as { $gte?: Date; $lte?: Date };
      rows = rows.filter((row) => {
        // Apply inclusive requested dates to fallback feedback rows.
        const ts = new Date(row.date).getTime();
        if (range.$gte && ts < range.$gte.getTime()) return false;
        if (range.$lte && ts > range.$lte.getTime()) return false;
        return true;
      });
    }
    return { source: "memory", data: rows.slice(0, limit) };
  }

  /** Return a bounded newest-first feedback list and identify which store supplied it. */
  async list(ctx: AppContext, limit: number) {
    const { res } = ctx;
    try {
      if (isMongoConnected()) {
        const data = await feedbackModel
          .find()
          .sort({ date: -1 })
          .limit(limit)
          .lean();
        res.status(200).json({ source: "mongo", count: data.length, data });
        return;
      }
      const data = [...memoryFeedback].reverse().slice(0, limit);
      res.status(200).json({ source: "memory", count: data.length, data });
    } catch (e: any) {
      console.error("[FeedbackService] Error in list:", e);
      res.status(500).json({
        code: 500,
        message: e.message || "Internal Server Error",
      });
    }
  }
}
