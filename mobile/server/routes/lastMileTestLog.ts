import express from "express";
import { LastMileTestLogController } from "../controllers/lastMileTestLog";

const route = express.Router();
const lastMileTestLogController = new LastMileTestLogController();

route.get("/", (req, res) => lastMileTestLogController.list(req, res));
route.get("/export.csv", (req, res) => lastMileTestLogController.exportCsv(req, res));
route.get("/evaluation", (req, res) => lastMileTestLogController.evaluation(req, res));
// Mykael (#35, mykael-dashboard-retry-test): register POST /:id/retry here
// with his controller/service. The duplicate /:id/replay route was removed.
route.get("/:id", (req, res) => lastMileTestLogController.getOne(req, res));
route.patch("/:id/review", (req, res) => lastMileTestLogController.updateReview(req, res));

export default route;
