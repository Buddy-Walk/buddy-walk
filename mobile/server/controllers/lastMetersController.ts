import { MobileLastMetersService } from "../services/mobileLastMeters";
import { Request, Response } from "express";
import { canRunLocalLastMeters } from "../config/serverMode";
import { parseLastMetersRequest } from "../utils/lastMetersReplay";
import type { LastMetersPath } from "../config/lastMetersPaths";

const lastMetersService = new MobileLastMetersService();

export class LastMetersController {
  async lastMetersRequest(req: Request, res: Response, requestPath: LastMetersPath) {
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
      await lastMetersService.lastMetersRequest({ req, res }, request, image, requestPath);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  }
}
