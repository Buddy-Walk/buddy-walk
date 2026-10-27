import express, { Application } from "express";
import { getServiceRouting } from "../config/serverMode";
import { LastMetersController } from "../controllers/lastMetersController";
import { mountLastMetersProxy } from "../middleware/upstreamProxy";
import { mobileReviewPanoramaStatus } from "../services/mobileLastMeters";
import { postOnLastMetersPaths } from "./lastMetersPaths";

const route = express.Router();

route.get("/last-meters/review-status", (_req, res) => {
  // Let deployments be checked without uploading a photo or consuming provider calls.
  res.setHeader("Cache-Control", "no-store");
  res.json(mobileReviewPanoramaStatus());
});

/**
 * Serves Last Meters here or through buddywalk.app. Street View must run
 * here when the keys exist, so routing only proxies it when they don't.
 */
export function mountLastMeters(app: Application): void {
  if (getServiceRouting().lastMeters === "proxy") {
    mountLastMetersProxy(app);
    return;
  }
  const lastMetersController = new LastMetersController();
  postOnLastMetersPaths(app, (req, res, requestPath) => {
    void lastMetersController.lastMetersRequest(req, res, requestPath);
  });
}

export default route;
