import type { ChatCompletionContentPartImage } from "openai/resources";
import { directionsPrompt, imagePrompt, videoPrompt } from "../types";
import type { QuestionReply, QuestionResult } from "./questionReply";
import type { QuestionRequest } from "./questionRequest";
import {
  getVerifiedNearbyWalkingDirections,
  type VerifiedWalkingRoute,
} from "./verifiedDestination";

/**
 * What a data source gives the model for a Question. Each string is joined as
 * it is, so leading newlines are part of it.
 */
export interface Evidence {
  /** Added to the end of the prompt. */
  prompt?: string;
  /** Added to the end of the system message's relevant data. */
  relevantData?: string;
  /** The data the Question's history entry records. */
  data?: string;
  /** Sent to the model after the Question's own frames. */
  images?: ChatCompletionContentPartImage[];
  /** The Doorfront panorama the answer is saved to as its description. */
  panoramaId?: string;
  /** The walking route sent back with the answer. */
  route?: VerifiedWalkingRoute;
  /** The tool the AI request log row names. */
  toolUsed?: string;
}

/** The prompt for a photo or video Question, which skips tool routing. */
export function visualEvidence(visual: NonNullable<QuestionRequest["visual"]>): Evidence {
  return visual === "video"
    ? { prompt: videoPrompt, toolUsed: "videoDescription" }
    : { prompt: imagePrompt, toolUsed: "imageDescription" };
}

/** Tells evidence from a reply that ends the Question. */
export function isReply(found: Evidence | QuestionResult): found is QuestionResult {
  return "status" in found;
}

/**
 * The tool each verified-directions lookup logs, when it finds the destination
 * and when it does not. The up-front lookup and the one after tool routing
 * have always logged differently; #30 decides which is right.
 */
const DIRECTIONS_TOOL_USED = {
  "up front": { found: "verifiedNearbyWalkingDirections", notFound: undefined },
  "after routing": { found: "generateGoogleDirectionAPILink", notFound: "generateGoogleDirectionAPILink" },
} as const;

/**
 * Walking directions to a Verified destination near the user. Answers without
 * the model when the Question has no frames, and refuses when the destination
 * cannot be verified; otherwise returns the route for the model to describe
 * against the frames.
 * `lookup` is "up front" for a Question read as asking for a nearby place, and
 * "after routing" when the routing call picked the directions tool.
 */
export async function verifiedWalkingDirections({
  lookup,
  destination,
  request,
  reply,
}: {
  lookup: keyof typeof DIRECTIONS_TOOL_USED;
  destination: string | null;
  request: QuestionRequest;
  reply: QuestionReply;
}): Promise<Evidence | QuestionResult> {
  const toolUsed = DIRECTIONS_TOOL_USED[lookup];
  if (request.location === "missing" || !destination) {
    return reply.destinationNotVerified(destination || "destination", toolUsed.notFound);
  }
  try {
    const verified = await getVerifiedNearbyWalkingDirections(
      request.coords.latitude,
      request.coords.longitude,
      destination,
    );
    if (request.frameCount === 0) {
      return await reply.verifiedDirections(verified, toolUsed.found);
    }
    const data = `Directions:\n${verified.directionsText}`;
    return {
      prompt: directionsPrompt,
      relevantData:
        `\nVerified nearby destination: ${verified.placeName}, ` +
        `${verified.placeAddress}, approximately ` +
        `${Math.round(verified.distanceMeters)} meters away.\n` +
        data,
      data,
      route: verified.route,
      toolUsed: toolUsed.found,
    };
  } catch (error) {
    console.error("Verified walking directions lookup failed:", error);
    return reply.destinationNotVerified(destination, toolUsed.notFound);
  }
}
