import express from "express";
import { LastMetersController } from "../controllers/lastMetersController";
import { mobileReviewPanoramaStatus } from "../services/mobileLastMile";

const route = express.Router();
const lastMetersController = new LastMetersController();

route.get("/last-mile/review-status", (_req, res) => {
  // Let deployments be checked without uploading a photo or consuming provider calls.
  res.setHeader("Cache-Control", "no-store");
  res.json(mobileReviewPanoramaStatus());
});

route.post("/last-mile", (req, res) => lastMetersController.lastMileRequest(req, res));

export default route;
