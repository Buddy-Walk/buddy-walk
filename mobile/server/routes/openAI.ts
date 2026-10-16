import express from "express";
import { OpenAIController } from "../controllers/openAI";
import { TranscribeController } from "../controllers/transcribe";
import { mobileReviewPanoramaStatus } from "../services/mobileLastMile";

const route = express.Router();
const openAIController = new OpenAIController();
const transcribeController = new TranscribeController();

route.get("/last-mile/review-status", (_req, res) => {
  // Let deployments be checked without uploading a photo or consuming provider calls.
  res.setHeader("Cache-Control", "no-store");
  res.json(mobileReviewPanoramaStatus());
});

route.post("/text", openAIController.textRequest);
route.post("/audio", openAIController.audioRequest);
route.post("/parseRequest", openAIController.parseUserRequest);
route.post("/last-mile", (req, res) => openAIController.lastMileRequest(req, res));
route.post(
  "/transcribe",
  express.raw({ type: "*/*", limit: "10mb" }),
  (req, res) => transcribeController.transcribe(req, res)
);

export default route;
