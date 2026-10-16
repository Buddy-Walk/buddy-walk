import { Request, Response } from "express";
import { CompanionService } from "../services/companion";

const service = new CompanionService();

/** Accept only actual finite numbers; numeric strings and nonfinite sensor readings are invalid. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export class CompanionController {
  /** Validate the optional short display name before creating a private location-sharing session. */
  async createSession(req: Request, res: Response): Promise<void> {
    const { displayName } = req.body ?? {};
    if (displayName !== undefined && typeof displayName !== "string") {
      res.status(400).json({ error: "displayName must be a string" });
      return;
    }
    if (typeof displayName === "string" && displayName.length > 60) {
      res.status(400).json({ error: "displayName too long (max 60 chars)" });
      return;
    }
    await service.createSession({ req, res }, displayName);
  }

  /**
   * Validate the owner credentials and coordinate bounds, sanitize optional sensors, and publish a
   * companion location update.
   */
  async ping(req: Request, res: Response): Promise<void> {
    const { token } = req.params;
    const { ownerSecret, lat, lon, accuracy, heading, speed } = req.body ?? {};

    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token required" });
      return;
    }
    if (typeof ownerSecret !== "string" || !ownerSecret) {
      res.status(400).json({ error: "ownerSecret required" });
      return;
    }
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
      res.status(400).json({ error: "lat and lon must be finite numbers" });
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      res.status(400).json({ error: "lat/lon out of range" });
      return;
    }
    await service.ping({ req, res }, token, ownerSecret, {
      lat,
      lon,
      accuracy: isFiniteNumber(accuracy) ? accuracy : undefined,
      heading: isFiniteNumber(heading) ? heading : null,
      speed: isFiniteNumber(speed) ? speed : null,
    });
  }

  /** Require both session token and owner secret before ending location sharing. */
  async stop(req: Request, res: Response): Promise<void> {
    const { token } = req.params;
    const { ownerSecret } = req.body ?? {};
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token required" });
      return;
    }
    if (typeof ownerSecret !== "string" || !ownerSecret) {
      res.status(400).json({ error: "ownerSecret required" });
      return;
    }
    await service.stop({ req, res }, token, ownerSecret);
  }

  /** Require a viewer token before returning the latest public session snapshot. */
  async snapshot(req: Request, res: Response): Promise<void> {
    const { token } = req.params;
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token required" });
      return;
    }
    await service.snapshot({ req, res }, token);
  }
}
