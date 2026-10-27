import express from "express";
import { QuestionController } from "../controllers/questionController";

const route = express.Router();
const questionController = new QuestionController();

route.post("/text", questionController.textRequest);
route.post("/audio", questionController.audioRequest);
route.post("/parseRequest", questionController.parseUserRequest);

export default route;
