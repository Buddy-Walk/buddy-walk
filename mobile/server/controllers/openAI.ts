import { OpenAIQuestionService } from "../services/openAIQuestionService";
import type { QuestionService } from "../services/questionService";
import { MobileLastMileService } from "../services/mobileLastMile";
import { GeminiService } from "../services/gemini";
import {textRequestBody} from "../types";
import { Request, Response } from "express";
import { getPanoramaData } from "../services/doorfront"
import { canRunLocalLastMile } from "../config/serverMode";
import { parseLastMetersRequest } from "../utils/lastMileReplay";

function createTextAiService(): QuestionService {
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (hasGemini && !hasOpenAi) {
    return new GeminiService();
  }
  return new OpenAIQuestionService();
}

const openAIService = createTextAiService();
const lastMileOpenAIService = new MobileLastMileService();

export class OpenAIController {

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

  async textRequest(req: Request, res: Response): Promise<void> {
    const body: textRequestBody = req.body;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await openAIService.textRequest({req, res}, body);
  }

  async audioRequest(req: Request, res: Response): Promise<void> {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await openAIService.audioRequest({req, res}, text);
  }

  async doorfrontPanorama(req: Request, res: Response): Promise<void> {
    const { address } = req.body;
    if (typeof address !== 'string' || !address.trim()) {
      res.status(400).json({ error: 'address is required and must be a non-empty string' });
      return;
    }
    await getPanoramaData({req, res}, address);
  }
  
  async lastMileRequest(req: Request, res: Response) {
    try {
      const request = parseLastMetersRequest(req.body);
      const image = req.body?.image;
      if (!request || typeof image !== "string" || !image.startsWith("data:image/")) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
      }
      if (!canRunLocalLastMile()) {
        return res.status(503).json({
          error:
            "Last Meters requires OPENAI_API_KEY and GOOGLE_MAPS_API_KEY (or GOOGLE_API_KEY) on this backend.",
        });
      }
      await lastMileOpenAIService.lastMileRequest({ req, res }, request, image);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  }
}
