import { Router } from "express";
import { addLead, getLeads } from "./lead.controller";
import { validate } from "@middlewares/validate.middleware";
import { leadSchema } from "./lead.validation";

const leadRoutes = Router();

leadRoutes.post("/", validate(leadSchema), addLead);
leadRoutes.get("/", getLeads);

export default leadRoutes;





