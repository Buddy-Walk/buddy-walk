import {
  textRequestBody,
  AIPrompt,
  AppContext,
} from "../types";
import dotenv from "dotenv";
import {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
} from "openai/resources";
import { addPanoramaDescription } from "./doorfront";
import { getOpenAIClient } from "./openAIClient";
import {
  formatHistoryForPrompt,
  getConversationHistory,
} from "../utils/conversationHistory";
import { geocodeCoordinates } from "./googleMaps";
import { readQuestionRequest } from "./questionRequest";
import { QuestionReply, type QuestionResult } from "./questionReply";
import { isReply, verifiedWalkingDirections, visualEvidence } from "./questionEvidence";
import { routedEvidence, routeQuestion } from "./questionTools";
dotenv.config();

function maxTokensForFeature(feature?: string): number {
  switch (feature) {
    case "mta":
      return 100;
    case "location_qa":
      return 80;
    case "directions":
      return 280;
    case "photo_qa":
    case "video_qa":
      return 150;
    default:
      return 120;
  }
}

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
    const analytics = content.analytics;

    if (request.needsVerifiedNearbyAnswer && request.location !== "trusted") {
      return reply.locationUnavailable();
    }

    let systemContent = "";
    const userContent: (ChatCompletionContentPartText | ChatCompletionContentPartImage)[] = [
      { type: "text", text: content.text },
    ];
    if (
      Array.isArray(content.image) &&
      content.image.length > 0 &&
      content.image[0] !== null
    ) {
      content.image.forEach((image) => {
        userContent.push({
          type: "image_url",
          image_url: {
            url: image,
            detail: "auto",
          },
        });
      });
    }
    if (
      content.coords &&
      !request.needsVerifiedNearbyAnswer &&
      !request.visual
    ) {
      const geocodedCoords = await geocodeCoordinates(
        content.coords.latitude,
        content.coords.longitude,
      );
      systemContent += `Current Address: ${geocodedCoords[0].formatted_address} `;
    }
    if (content.coords?.heading !== undefined) {
        systemContent += `, Heading (Compass Direction): ${content.coords.heading}`;
      }
    if (content.coords?.orientation) {
        systemContent += `, Orientation - Alpha: ${content.coords.orientation.alpha}, Beta: ${content.coords.orientation.beta}, Gamma: ${content.coords.orientation.gamma}`;
      }

    const evidence = request.needsVerifiedNearbyAnswer
      ? await verifiedWalkingDirections({ path: "up front", destination: request.nearbyQuery, request, reply })
      : request.visual
        ? visualEvidence(request.visual)
        : await routedEvidence({ text: content.text, request, reply });
    if (isReply(evidence)) return evidence;
    const { toolUsed } = evidence;
    let completeAIPrompt = AIPrompt + (evidence.prompt ?? "");
    systemContent += evidence.relevantData ?? "";
    userContent.push(...(evidence.images ?? []));

    // openAI separate text request
    try {
      console.log("system prompt: ", systemContent);
      systemContent += `\nCurrent Date and Time (Eastern): ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;
      const priorHistory = getConversationHistory(analytics);
      const recentHistory = priorHistory.slice(-3);
      if (
        toolUsed === "generateGoogleDirectionAPILink" &&
        content.image &&
        content.image[0] !== null
      ) {
        completeAIPrompt +=
          "\n\nCRITICAL INSTRUCTION: The user attached an image/video of their surroundings for 'Last Meters' navigation. DO NOT just read the GPS directions. You MUST analyze the image and use it to guide the user exactly to the physical door or entrance relative to their current view.";
      }
      const combinedSystemMessage =
        completeAIPrompt +
        "\n\nRelevant data: " +
        systemContent +
        "\n\nChat history: " +
        formatHistoryForPrompt(recentHistory);
      const chatCompletion = await getOpenAIClient().chat.completions.create({
        messages: [
          { role: "system", content: combinedSystemMessage },
          { role: "user", content: userContent },
        ],
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: maxTokensForFeature(analytics?.feature),
      });
      console.log("OpenAI API response:", chatCompletion.usage?.total_tokens);
      const outputText = chatCompletion.choices[0].message.content as string;

      // Save the answer as the panorama's Doorfront description.
      if (evidence.panoramaId) {
          console.log("Generating new description for DF database...");
        await addPanoramaDescription(evidence.panoramaId, outputText);
      }
      return await reply.modelAnswer(
        { output: outputText, data: evidence.data ?? "", route: evidence.route ?? null },
        { toolUsed, tokenCount: chatCompletion.usage?.total_tokens },
      );
    } catch (e: any) {
      console.error("Error with OpenAI API request:", e);
      return reply.modelFailed(e, toolUsed);
    }
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
