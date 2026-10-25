import express from "express";
import { QuestionController } from "../controllers/questionController";
import { TranscribeController } from "../controllers/transcribe";

const route = express.Router();
const questionController = new QuestionController();
const transcribeController = new TranscribeController();

route.post("/text", questionController.textRequest);
route.post("/audio", questionController.audioRequest);
route.post("/parseRequest", questionController.parseUserRequest);
route.post(
  "/transcribe",
  express.raw({ type: "*/*", limit: "10mb" }),
  (req, res) => transcribeController.transcribe(req, res)
);

export default route;
