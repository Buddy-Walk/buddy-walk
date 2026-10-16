import express from "express";
import { LastMileTestLogController } from "../controllers/lastMileTestLog";

const route = express.Router();
const lastMileTestLogController = new LastMileTestLogController();

route.get("/", /* Delegate the admin trial-list endpoint while retaining the controller instance binding. */ (req, res) => lastMileTestLogController.list(req, res));
route.get("/export.csv", /* Delegate the admin CSV export endpoint to the trial controller. */ (req, res) => lastMileTestLogController.exportCsv(req, res));
route.get("/evaluation", /* Delegate the field-evaluation summary endpoint to the trial controller. */ (req, res) => lastMileTestLogController.evaluation(req, res));
// Mykael (#35, mykael-dashboard-retry-test): register POST /:id/retry here
// with his controller/service. The duplicate /:id/replay route was removed.
route.get("/:id", /* Delegate a single-trial lookup to the trial controller. */ (req, res) => lastMileTestLogController.getOne(req, res));
route.patch("/:id/review", /* Delegate reviewer updates to the trial controller without bypassing its validation. */ (req, res) => lastMileTestLogController.updateReview(req, res));

export default route;
