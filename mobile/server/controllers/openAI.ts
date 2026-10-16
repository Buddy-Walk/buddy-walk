import {OpenAIService} from "../services/openAI";
import { GeminiService } from "../services/gemini";
import {textRequestBody} from "../types";
import { Request, Response } from "express";
import { getPanoramaData } from "../services/doorfront"
import { canRunLocalLastMile } from "../config/serverMode";

/**
 * Use Gemini for text only when it is configured without OpenAI; otherwise construct the
 * OpenAI-backed service.
 */
function createTextAiService(): OpenAIService | GeminiService {
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (hasGemini && !hasOpenAi) {
    return new GeminiService();
  }
  return new OpenAIService();
}

const openAIService = createTextAiService();
const lastMileOpenAIService = new OpenAIService();

export class OpenAIController {

  /**
   * Validate the question and numeric coordinates before handing request parsing to the selected
   * text service.
   */
  async parseUserRequest(req: Request, res: Response) {
    const { text, lat, lng } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      res.status(400).json({ error: 'lat and lng must be numbers' });
      return;
    }
    await openAIService.parseUserRequest({req, res}, text, lat, lng);
  }

  /** Reject an empty question before invoking the configured text-answer service. */
  async textRequest(req: Request, res: Response): Promise<void> {
    const body: textRequestBody = req.body;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await openAIService.textRequest({req, res}, body);
  }

  /** Validate the speech text before requesting synthesized audio. */
  async audioRequest(req: Request, res: Response): Promise<void> {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await openAIService.audioRequest({req, res}, text);
  }

  /** Require a destination address before resolving its panorama metadata. */
  async doorfrontPanorama(req: Request, res: Response): Promise<void> {
    const { address } = req.body;
    if (typeof address !== 'string' || !address.trim()) {
      res.status(400).json({ error: 'address is required and must be a non-empty string' });
      return;
    }
    await getPanoramaData({req, res}, address);
  }
  
  /**
   * Validate Last Meters coordinates, photo, destination, and local capability before passing
   * original sensor evidence to the pipeline; return a controlled error if execution fails.
   */
  async lastMileRequest(req: Request, res: Response) {
    try {
      const {
        lat,
        lng,
        image,
        destination,
        heading,
        gpsAccuracyMeters,
        compassAccuracyLevel,
        sensors,
      } = req.body;
      const validCoordinates = typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
        typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180;
      if (!validCoordinates || typeof image !== "string" || !image.startsWith("data:image/") || typeof destination !== "string" || !destination.trim()) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
      }
      if (!canRunLocalLastMile()) {
        return res.status(503).json({
          error:
            "Last Meters requires OPENAI_API_KEY and GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) on this backend.",
        });
      }
      const deviceHeading =
        typeof heading === "number" && Number.isFinite(heading) ? heading : undefined;
      const accuracy =
        typeof gpsAccuracyMeters === "number" && Number.isFinite(gpsAccuracyMeters)
          ? gpsAccuracyMeters
          : undefined;
      const compassLevel =
        typeof compassAccuracyLevel === "number" &&
        Number.isFinite(compassAccuracyLevel)
          ? compassAccuracyLevel
          : undefined;
      await lastMileOpenAIService.lastMileRequest(
        { req, res },
        Number(lat),
        Number(lng),
        image,
        destination.trim(),
        deviceHeading,
        accuracy,
        compassLevel,
        sensors,
      );
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}
