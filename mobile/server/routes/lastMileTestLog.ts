import express from "express";
import { LastMileTestLogController } from "../controllers/lastMileTestLog";

const route = express.Router();
const lastMileTestLogController = new LastMileTestLogController();

route.get("/", (req, res) => lastMileTestLogController.list(req, res));
route.get("/export.csv", (req, res) => lastMileTestLogController.exportCsv(req, res));
route.get("/evaluation", (req, res) => lastMileTestLogController.evaluation(req, res));
route.post("/:id/replay", (req, res) => lastMileTestLogController.replay(req, res));
route.get("/:id", (req, res) => lastMileTestLogController.getOne(req, res));
route.patch("/:id/review", (req, res) => lastMileTestLogController.updateReview(req, res));

export default route;
