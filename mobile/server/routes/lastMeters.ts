import express from "express";
import { LastMetersController } from "../controllers/lastMetersController";
import { mobileReviewPanoramaStatus } from "../services/mobileLastMeters";

const route = express.Router();
const lastMetersController = new LastMetersController();

route.get("/last-meters/review-status", (_req, res) => {
  // Let deployments be checked without uploading a photo or consuming provider calls.
  res.setHeader("Cache-Control", "no-store");
  res.json(mobileReviewPanoramaStatus());
});

route.post("/last-mile", (req, res) => lastMetersController.lastMetersRequest(req, res));

export default route;
