import type OpenAI from "openai";
import { buildLastMetersDistanceSentence, buildLastMetersTurnInstruction } from "../utils/lastMetersNavigation";
import type { LastMetersGuidancePolicy } from "../utils/lastMetersGuidancePolicy";
import type { WalkingEvidence } from "../utils/lastMetersPolicy";
import type { LastMetersRequestInput } from "../utils/lastMetersReplay";
import { getOpenAIClient } from "./openAIClient";
import type { DestinationStreetViewReference } from "./lastMetersPanoramaMatching";
import type { GuidanceTarget, LastMetersTrial } from "./lastMetersTrial";
import type { VerifiedNearbyDestination } from "./verifiedDestination";

/** What composing the guidance needs once the turn decision has gone ahead. */
export interface GuidanceInput {
  request: Pick<LastMetersRequestInput, "destination">;
  /** The user's photo. */
  image: string;
  place: VerifiedNearbyDestination;
  entrance: GuidanceTarget;
  /** From the user to the entrance. */
  destinationBearing: number;
  /** The heading the turn decision measures the turn from. */
  turnHeading: number;
  walkingEvidence: WalkingEvidence;
  /** The Street View photo aimed at the destination, when panorama matching confirmed the destination in it. */
  reference?: DestinationStreetViewReference;
  panoramaDate?: string;
  closedNotice: string;
  policy: Pick<LastMetersGuidancePolicy, "landmarkContext" | "finalOutput">;
}

/** The turn instruction and the full answer built around it. */
export interface Guidance {
  turnInstruction: string;
  finalOutput: string;
}

/**
 * Builds the turn instruction and distance, asks for landmarks from the
 * user's photo (Step 3), and puts them together in the guidance policy's words.
 */
export async function composeGuidance(trial: LastMetersTrial, input: GuidanceInput): Promise<Guidance> {
  const { request: { destination }, image, place, entrance, destinationBearing, turnHeading, reference } = input;
  // ==========================================
  // TYPESCRIPT MATH CALCULATION (Bulletproof Turn Logic)
  // ==========================================
  const turnInstruction = buildLastMetersTurnInstruction(turnHeading, destinationBearing);
  const distanceSentence = buildLastMetersDistanceSentence(
    place.placeName,
    entrance.distanceMeters,
    !turnInstruction.startsWith("No turn"),
  );

  // ==========================================
  // STEP 3: ACCESSIBLE GUIDANCE & LANDMARKS
  // ==========================================
  trial.stage("accessible guidance");
  console.log("   ➤ Step 3: Generating Accessible Guidance...");
  const destinationReferenceContext = reference
    ? `A separate Street View image for "${place.placeName}" is also provided. It was captured ${reference.date || "on an unknown date"} and may be outdated. Use it only as historical entrance context, never as proof of current conditions.`
    : "No separate destination reference image is provided.";
  const step3Prompt = `You are an orientation assistant for a blind pedestrian.
The validated turn instruction is: "${turnInstruction}"
${destinationReferenceContext}
Describe at most two stable physical landmarks. Use the user's current photo for a landmark useful while turning in place. If a destination reference is provided, you may also describe one clearly visible entrance feature and must prefix it with "Street View reference:".
Only mention stable, cane-detectable or tactile features such as a wall edge, curb, doorway recess, railing, or steps.
Do not name, describe, or direct the user toward any business other than "${place.placeName || destination}". If the requested destination's entrance is not verified, omit entrance guidance rather than substituting a neighboring storefront.
Never claim that a reference-image feature is currently present or visible from the user's position. Never invent an object. Never say "look", "see", "watch", "keep an eye out", or promise that a path is clear.
Do not instruct the user to walk forward or cross a street. If no reliable landmark is visible, reply exactly: NO_RELIABLE_LANDMARKS.
Keep the response to two short sentences and do not repeat the turn instruction.` + (input.policy.landmarkContext ?? "");
  const step3UserContent: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: "text", text: "--- USER'S CURRENT PHOTO ---" },
    { type: "image_url", image_url: { url: image, detail: "high" } },
  ];
  if (reference) {
    step3UserContent.push(
      {
        type: "text",
        text: "--- DESTINATION-FOCUSED STREET VIEW REFERENCE ---",
      },
      {
        type: "image_url",
        image_url: { url: reference.photo, detail: "high" },
      },
    );
  }
  const step3Response = await getOpenAIClient().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: step3Prompt },
      { role: "user", content: step3UserContent },
    ],
    temperature: 0.1,
    max_tokens: 100,
  });

  const step3Text = step3Response.choices[0].message.content?.trim() || "";
  const noLandmarks = !step3Text || /\bNO_RELIABLE_LANDMARKS\b/i.test(step3Text);
  const landmarksGuidance = noLandmarks
    ? "No reliable physical landmark was identified. Turn in place without moving forward, then confirm your orientation before continuing."
    : step3Text;
  trial.step({
    name: "accessible_guidance",
    prompt: step3Prompt,
    response: step3Text,
    model: "gpt-4o-mini",
    success: !noLandmarks,
    error: noLandmarks ? "No reliable physical landmark was identified." : undefined,
    tokenCount: step3Response.usage?.total_tokens,
  });

  // --- FINAL OUTPUT FOR TERMINAL ---
  console.log("\n💬 AI 3-Step Navigation Output:");
  console.log(
    `- 1st Match (Current View): The user is facing ${turnHeading}°.`,
  );
  console.log(
    `- 2nd Match (Target Store): The target '${destination}' is located at ${destinationBearing}°.`,
  );
  console.log(
    `- 3rd Step (Guidance): ${turnInstruction} Landmarks: ${landmarksGuidance}`,
  );
  console.log("=========================================\n");

  const finalOutput = input.policy.finalOutput({
    turnInstruction,
    distanceSentence,
    landmarksGuidance,
    closedNotice: input.closedNotice,
    panoramaDate: input.panoramaDate,
    walkingEvidence: input.walkingEvidence,
  });
  return { turnInstruction, finalOutput };
}
