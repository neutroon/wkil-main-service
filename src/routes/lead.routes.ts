import { Router } from "express";
import { addLead, getLeads } from "../controllers/lead.controller";
import { validate } from "../middlewares/validate.middleware";
import { leadSchema } from "../validations/lead.validation";

const leadRoutes = Router();

leadRoutes.post("/", validate(leadSchema), addLead);
leadRoutes.get("/", getLeads);

export default leadRoutes;
