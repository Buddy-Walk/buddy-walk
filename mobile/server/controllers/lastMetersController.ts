import { MobileLastMetersService } from "../services/mobileLastMeters";
import { Request, Response } from "express";
import { canRunLocalLastMeters } from "../config/serverMode";
import { parseLastMetersRequest } from "../utils/lastMetersReplay";
import type { LastMetersPath } from "../config/lastMetersPaths";

import {
  LAST_METERS_PROGRESS_CONTENT_TYPE, type LastMetersProgressEvent, type LastMetersStreamEvent,
} from "../../src/utils/lastMetersProgress";

const lastMetersService = new MobileLastMetersService();

function openProgressResponse(res: Response) {
  let streaming = false;
  const canWrite = () => !res.destroyed && !res.writableEnded;
  const line = (event: LastMetersStreamEvent) => JSON.stringify(event) + "\n";

  return {
    onProgress(event: LastMetersProgressEvent) {
      if (!canWrite()) return;
      if (!streaming) {
        res.status(200);
        res.set({
          "Content-Type": LAST_METERS_PROGRESS_CONTENT_TYPE + "; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        });
        streaming = true;
      }
      res.write(line(event)); // Flush the first event with the response headers.
    },
    respond(status: number, body: Record<string, unknown>) {
      if (!canWrite()) return;
      if (streaming) res.end(line({ type: "result", status, body }));
      else res.status(status).json(body);
    },
  };
}

export class LastMetersController {
  async lastMetersRequest(req: Request, res: Response, requestPath: LastMetersPath) {
    const wantsProgress = req.get("accept")?.split(",").some(value =>
      value.trim() === LAST_METERS_PROGRESS_CONTENT_TYPE);
    const progress = wantsProgress ? openProgressResponse(res) : undefined;
    try {
      const request = parseLastMetersRequest(req.body);
      const image = req.body?.image;
      if (!request || typeof image !== "string" || !image.startsWith("data:image/")) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
      }
      if (!canRunLocalLastMeters()) {
        return res.status(503).json({
          error:
            "Last Meters requires OPENAI_API_KEY and GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) on this backend.",
        });
      }
      await lastMetersService.lastMetersRequest({ req, res }, request, image, requestPath, progress);
    } catch (error) {
      const body = { error: "Internal server error" };
      if (progress) progress.respond(500, body);
      else if (!res.headersSent) res.status(500).json(body);
    }
  }
}
