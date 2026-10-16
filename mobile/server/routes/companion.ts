import express from "express";
import { CompanionController } from "../controllers/companion";

const route = express.Router();
const controller = new CompanionController();

route.get("/health", (_req, res) => {
  // Expose a small companion-service availability response.
  res.status(200).json({ ok: true });
});

// Mobile app creates a sharing session and gets back { token, ownerSecret }
route.post("/create", /* Create a companion session through its validation controller. */ (req, res) => controller.createSession(req, res));

// Mobile app pushes a new location for a session it owns
route.post("/ping", (req, res) => {
  // Normalize a body-supplied session token into route parameters before validating a location
  // update.
  req.params = { ...req.params, token: String(req.body?.token ?? "") };
  controller.ping(req, res);
});
route.post("/stop", (req, res) => {
  // Normalize a body-supplied session token before validating a stop request.
  req.params = { ...req.params, token: String(req.body?.token ?? "") };
  controller.stop(req, res);
});
route.get("/snapshot", (req, res) => {
  // Normalize a query-supplied viewer token before reading a session snapshot.
  req.params = { ...req.params, token: String(req.query.token ?? "") };
  controller.snapshot(req, res);
});

// Legacy path shape kept for older clients.
route.post("/:token/ping", /* Handle a location update addressed by its session token in the route. */ (req, res) => controller.ping(req, res));

// Mobile app cancels a session it owns
route.post("/:token/stop", /* Handle a stop request addressed by its session token in the route. */ (req, res) => controller.stop(req, res));

route.get("/:token/snapshot", /* Read the companion snapshot addressed by its viewer token in the route. */ (req, res) => controller.snapshot(req, res));

export default route;
