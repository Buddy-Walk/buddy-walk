import type { ChatCompletionContentPartImage, ChatCompletionContentPartText } from "openai/resources";
import { AIPrompt, type textRequestBody } from "../types";
import { formatHistoryForPrompt, getConversationHistory } from "../utils/conversationHistory";
import { addPanoramaDescription } from "./doorfront";
import { getOpenAIClient } from "./openAIClient";
import type { Evidence } from "./questionEvidence";
import type { QuestionReply, QuestionResult } from "./questionReply";

const LAST_METERS_INSTRUCTION =
  "\n\nCRITICAL INSTRUCTION: The user attached an image/video of their surroundings for 'Last Meters' navigation. DO NOT just read the GPS directions. You MUST analyze the image and use it to guide the user exactly to the physical door or entrance relative to their current view.";

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
 * Answers a Question with the model, from where the user is and the evidence a
 * data source gathered.
 * `location` starts the system message's relevant data, as describeLocation returns it.
 */
export async function answerWithModel({
  content,
  location,
  evidence,
  reply,
}: {
  content: textRequestBody;
  location: string;
  evidence: Evidence;
  reply: QuestionReply;
}): Promise<QuestionResult> {
  const { toolUsed } = evidence;
  let prompt = AIPrompt + (evidence.prompt ?? "");
  // Only the directions found after tool routing add this; #30 decides whether the up-front path should too.
  if (toolUsed === "generateGoogleDirectionAPILink" && content.image && content.image[0] !== null) {
    prompt += LAST_METERS_INSTRUCTION;
  }
  const userContent: (ChatCompletionContentPartText | ChatCompletionContentPartImage)[] = [
    { type: "text", text: content.text },
  ];
  if (Array.isArray(content.image) && content.image.length > 0 && content.image[0] !== null) {
    for (const image of content.image) {
      userContent.push({ type: "image_url", image_url: { url: image, detail: "auto" } });
    }
  }
  userContent.push(...(evidence.images ?? []));
  const relevantData = location + (evidence.relevantData ?? "");

  try {
    console.log("system prompt: ", relevantData);
    const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const recentHistory = getConversationHistory(content.analytics).slice(-3);
    const systemMessage =
      prompt +
      "\n\nRelevant data: " +
      relevantData +
      `\nCurrent Date and Time (Eastern): ${now}` +
      "\n\nChat history: " +
      formatHistoryForPrompt(recentHistory);
    const chatCompletion = await getOpenAIClient().chat.completions.create({
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userContent },
      ],
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: maxTokensForFeature(content.analytics?.feature),
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
