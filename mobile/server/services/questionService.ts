import type { AppContext, textRequestBody } from "../types";

/**
 * Answers a Question for /api/text, picks a tool for /api/parseRequest, and
 * reads text aloud for /api/audio. OpenAI and Gemini each implement it.
 * Each method sends its answer through ctx.res; callers ignore the result.
 */
export interface QuestionService {
  parseUserRequest(ctx: AppContext, text: string, lat: number, lng: number): Promise<unknown>;
  textRequest(ctx: AppContext, content: textRequestBody): Promise<unknown>;
  audioRequest(ctx: AppContext, text: string): Promise<unknown>;
}
