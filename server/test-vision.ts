import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../mobile/.env") });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function encodeImageToBase64(filePath: string): string {
  const imageBuffer = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
}

async function describeUserPhotoLandmarks(userImagePath: string, targetDestination: string) {
  const userImageBase64 = encodeImageToBase64(userImagePath);
  console.log(`\n🤖 Landmark description from the user photo for: [${targetDestination}]...`);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are an orientation assistant for the blind.
        Look at the user's current photo and describe physical, tactile landmarks near "${targetDestination}".
        Rule 1: Double-check Left vs Right in the photo.
        Rule 2: Mention physical objects like trash cans, steps, or building corners. Do NOT mention elevated text signs.
        Rule 3: Keep it conversational but concise.
        Do not invent entrance details that are not visible in the photo.`,
      },
      { role: "user", content: [{ type: "image_url", image_url: { url: userImageBase64 } }] },
    ],
    temperature: 0.1,
  });

  console.log(response.choices[0].message.content);
}

const localUserPhotoPath = path.resolve(__dirname, "my-photo.webp");
const finalDestination = "The Corner: Delli Grill";

(async () => {
  if (fs.existsSync(localUserPhotoPath)) {
    await describeUserPhotoLandmarks(localUserPhotoPath, finalDestination);
  } else {
    console.error(`❌ Error: Could not find your photo at ${localUserPhotoPath}`);
  }
})();
