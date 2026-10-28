import { textRequestBody, AppContext } from "../types";
import dotenv from "dotenv";
import { getOpenAIClient } from "./openAIClient";
import { readQuestionRequest } from "./questionRequest";
import { QuestionReply, type QuestionResult } from "./questionReply";
import { describeLocation } from "./questionLocation";
import { isReply, verifiedWalkingDirections, visualEvidence } from "./questionEvidence";
import { routedEvidence, routeQuestion } from "./questionTools";
import { answerWithModel } from "./questionAnswer";
dotenv.config();

/**
 * Answers a Question for /api/text, picks a tool for /api/parseRequest, and
 * reads text aloud for /api/audio.
 * Each method that takes ctx sends its answer through ctx.res; callers ignore the result.
 */
export class OpenAIQuestionService {
  async parseUserRequest(
    ctx: AppContext,
    text: string,
    lat: number,
    lng: number,
  ) {
    const { res } = ctx;
    const openAiResponse = await routeQuestion(text, lat, lng);
    if (!openAiResponse) {
      res.status(500).json({ error: "Error processing your request" });
      return;
    }
    res.status(200).json(openAiResponse);
  }

  /** Answers a Question and sends the answer. */
  async textRequest(ctx: AppContext, content: textRequestBody) {
    const { status, body } = await this.answerQuestion(content);
    ctx.res.status(status).json(body);
  }

  /** Answers a Question. Returns the answer instead of sending it, and leaves `content` as it was. */
  async answerQuestion(content: textRequestBody): Promise<QuestionResult> {
    const request = readQuestionRequest(content);
    const reply = new QuestionReply(content, request);

    if (request.needsVerifiedNearbyAnswer && request.location !== "trusted") {
      return reply.locationUnavailable();
    }
    const locationDescription = await describeLocation(content, request);
    const evidence = request.needsVerifiedNearbyAnswer
      ? await verifiedWalkingDirections({ path: "up front", destination: request.nearbyQuery, request, reply })
      : request.visual
        ? visualEvidence(request.visual)
        : await routedEvidence({ text: content.text, request, reply });
    if (isReply(evidence)) return evidence;
    return answerWithModel({ content, locationDescription, evidence, reply });
  }
  // ----------------------------------------------------------------------------------------------------------------
  //* OpenAI Audio API
  async audioRequest(ctx: AppContext, text: string) {
    const { res } = ctx;
    try {
      const mp3 = await getOpenAIClient().audio.speech.create({
        model: "tts-1",
        voice: "echo",
        input: text,
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());

      res.contentType("audio/mpeg");
      res.status(200).send(buffer);
    } catch (e) {
      console.error(e);
    }
  }
}
