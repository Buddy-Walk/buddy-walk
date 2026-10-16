import type { Request, Response } from 'express';
import { transcribeAudioBuffer } from '../services/transcribe';

export class TranscribeController {
  /**
   * Validate the raw audio content type and body, transcribe supported binary input, and return a
   * structured error for invalid uploads or service failure.
   */
  async transcribe(req: Request, res: Response): Promise<void> {
    const contentType = req.headers['content-type'];
    if (!contentType || typeof contentType !== 'string') {
      res.status(400).json({ error: 'Content-Type header is required' });
      return;
    }

    const body = req.body;
    let audio: Buffer;
    if (Buffer.isBuffer(body)) {
      audio = body;
    } else if (body instanceof ArrayBuffer) {
      audio = Buffer.from(body);
    } else if (typeof body === 'string') {
      audio = Buffer.from(body, 'binary');
    } else {
      res.status(400).json({ error: 'Expected raw audio body' });
      return;
    }

    try {
      const result = await transcribeAudioBuffer(audio, contentType);
      res.status(200).json(result);
    } catch (error) {
      console.error('transcribe error:', error);
      res.status(500).json({ error: 'Transcription failed' });
    }
  }
}
