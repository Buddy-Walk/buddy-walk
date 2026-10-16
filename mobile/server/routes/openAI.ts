import express from "express";
import { OpenAIController } from "../controllers/openAI";
import { TranscribeController } from "../controllers/transcribe";

const route = express.Router();
const openAIController = new OpenAIController();
const transcribeController = new TranscribeController();

route.post("/text", openAIController.textRequest);
route.post("/audio", openAIController.audioRequest);
route.post("/parseRequest", openAIController.parseUserRequest);
route.post("/last-mile", /* Delegate the Last Meters route to the AI controller with its instance context intact. */ (req, res) => openAIController.lastMileRequest(req, res));
route.post(
  "/transcribe",
  express.raw({ type: "*/*", limit: "10mb" }),
  /** Delegate raw audio uploads to the transcription controller with its instance context intact. */
  (req, res) => transcribeController.transcribe(req, res)
);

export default route;
