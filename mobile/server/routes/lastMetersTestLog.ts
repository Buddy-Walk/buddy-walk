import express from "express";
import { LastMileTestLogController } from "../controllers/lastMileTestLog";
import { asyncRoute } from "../utils/asyncRoute";

const route = express.Router();
const lastMileTestLogController = new LastMileTestLogController();

route.get("/", asyncRoute((req, res) => lastMileTestLogController.list(req, res)));
route.get("/export.csv", asyncRoute((req, res) => lastMileTestLogController.exportCsv(req, res)));
route.get("/evaluation", asyncRoute((req, res) => lastMileTestLogController.evaluation(req, res)));
route.get("/:id", asyncRoute((req, res) => lastMileTestLogController.getOne(req, res)));
route.post("/:id/retry", asyncRoute((req, res) => lastMileTestLogController.retry(req, res)));
route.patch("/:id/review", asyncRoute((req, res) => lastMileTestLogController.updateReview(req, res)));

export default route;
