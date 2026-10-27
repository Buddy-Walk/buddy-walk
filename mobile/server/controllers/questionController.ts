import { OpenAIQuestionService } from "../services/openAIQuestionService";
import {textRequestBody} from "../types";
import { Request, Response } from "express";
import { getPanoramaData } from "../services/doorfront"

const questionService = new OpenAIQuestionService();

export class QuestionController {

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
    await questionService.parseUserRequest({req, res}, text, lat, lng);
  }

  async textRequest(req: Request, res: Response): Promise<void> {
    const body: textRequestBody = req.body;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await questionService.textRequest({req, res}, body);
  }

  async audioRequest(req: Request, res: Response): Promise<void> {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }
    await questionService.audioRequest({req, res}, text);
  }

  async doorfrontPanorama(req: Request, res: Response): Promise<void> {
    const { address } = req.body;
    if (typeof address !== 'string' || !address.trim()) {
      res.status(400).json({ error: 'address is required and must be a non-empty string' });
      return;
    }
    await getPanoramaData({req, res}, address);
  }
}
