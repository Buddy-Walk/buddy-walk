import express from "express";
import { LastMetersTestLogController } from "../controllers/lastMetersTestLog";
import { asyncRoute } from "../utils/asyncRoute";

const route = express.Router();
const lastMetersTestLogController = new LastMetersTestLogController();

route.get("/", asyncRoute((req, res) => lastMetersTestLogController.list(req, res)));
route.get("/export.csv", asyncRoute((req, res) => lastMetersTestLogController.exportCsv(req, res)));
route.get("/evaluation", asyncRoute((req, res) => lastMetersTestLogController.evaluation(req, res)));
route.get("/:id", asyncRoute((req, res) => lastMetersTestLogController.getOne(req, res)));
route.post("/:id/retry", asyncRoute((req, res) => lastMetersTestLogController.retry(req, res)));
route.patch("/:id/review", asyncRoute((req, res) => lastMetersTestLogController.updateReview(req, res)));

export default route;
