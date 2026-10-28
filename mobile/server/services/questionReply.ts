import type { history, textRequestBody } from "../types";
import { aiRequestLogService } from "./aiRequestLog";
import { appendConversationHistory } from "../utils/conversationHistory";
import type { QuestionRequest } from "./questionRequest";
import type { VerifiedWalkingDirections, VerifiedWalkingRoute } from "./verifiedDestination";

/** What a Question sends back. */
export interface QuestionResult {
  status: number;
  body:
    | { output: string; history: history[]; route: VerifiedWalkingRoute | null }
    | { error: string };
}

/** What a 200 answer says, and the data its history entry records for later Questions. */
interface Answer {
  output: string;
  data: string;
  route: VerifiedWalkingRoute | null;
}

/** How the AI request log row ends. */
interface LogOutcome {
  success: boolean;
  toolUsed?: string;
  errorCode?: string;
  outputLength?: number;
  tokenCount?: number;
  hasCoords?: boolean;
}

/**
 * Builds everything a Question sends back: the history entry, the AI request
 * log row, and the response. Every way a Question can end goes through it.
 */
export class QuestionReply {
  private readonly startedAt = Date.now();

  constructor(
    private readonly content: textRequestBody,
    private readonly request: QuestionRequest,
  ) {}

  /** Refuses a Question that needs a Verified destination when the location cannot be trusted. */
  async locationUnavailable(): Promise<QuestionResult> {
    const output =
      this.request.location === "missing"
        ? "I could not determine your current location, so I will not guess at nearby directions. Check location access and try again."
        : "Your location is not accurate enough for nearby directions. Enable precise location and try again.";
    return this.recordAnswer(
      { output, data: "Current location was unavailable; no place lookup was attempted.", route: null },
      {
        success: false,
        errorCode: "current_location_unavailable",
        hasCoords: this.request.location !== "missing",
      },
    );
  }

  /** Refuses directions to a destination that could not be verified nearby. */
  async destinationNotVerified(destinationLabel: string, toolUsed?: string): Promise<QuestionResult> {
    return this.recordAnswer(
      {
        output:
          `I could not verify a nearby ${destinationLabel} from your current location. ` +
          "Try a more specific name or street address.",
        data: "Nearby destination lookup failed; no unverified location was used.",
        route: null,
      },
      { success: false, toolUsed, errorCode: "nearby_destination_not_verified" },
    );
  }

  /** Answers with verified walking directions, without the model. */
  async verifiedDirections(verified: VerifiedWalkingDirections, toolUsed: string): Promise<QuestionResult> {
    return this.recordAnswer(
      {
        output: `${verified.directionsText}\nDestination: ${verified.placeName}, ${verified.placeAddress}.`,
        data: `Verified local route to ${verified.placeName}.`,
        route: verified.route,
      },
      { success: true, toolUsed },
    );
  }

  /**
   * Answers with what the model said and the data it was given.
   * The model's output can be null at runtime even though it is typed as text.
   */
  async modelAnswer(
    answer: Answer,
    { toolUsed, tokenCount }: { toolUsed?: string; tokenCount?: number },
  ): Promise<QuestionResult> {
    return this.recordAnswer(answer, { success: true, toolUsed, tokenCount });
  }

  /** Answers 500 when the model call fails. Nothing is added to the history. */
  async modelFailed(error: Error, toolUsed?: string): Promise<QuestionResult> {
    await this.log({ success: false, toolUsed, errorCode: "openai_error" });
    return { status: 500, body: { error: "Error processing your request: " + error.message } };
  }

  /** Adds the answer to the history, logs it, and answers 200. */
  private async recordAnswer({ output, data, route }: Answer, outcome: LogOutcome): Promise<QuestionResult> {
    const updatedHistory = appendConversationHistory(this.content.analytics, {
      input: this.content.text,
      output,
      data,
    });
    await this.log({ outputLength: output?.length ?? 0, ...outcome });
    return { status: 200, body: { output, history: updatedHistory, route } };
  }

  /**
   * Past the location check, a row says the request had a location even when it
   * had none: the 0,0 stand-in used to be written into the request there, and
   * the rows are kept as they were.
   */
  private async log({ success, toolUsed, errorCode, outputLength, tokenCount, hasCoords = true }: LogOutcome) {
    const { analytics } = this.content;
    await aiRequestLogService.record({
      requestId: analytics?.requestId,
      installId: analytics?.installId,
      sessionId: analytics?.sessionId,
      platform: analytics?.platform,
      appVersion: analytics?.appVersion,
      feature: analytics?.feature,
      toolUsed,
      inputLength: this.content.text?.length ?? 0,
      hasImage: this.request.frameCount > 0,
      imageCount: this.request.frameCount,
      hasCoords,
      success,
      errorCode,
      latencyMs: Date.now() - this.startedAt,
      outputLength,
      tokenCount,
    });
  }
}
