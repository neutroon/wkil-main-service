import { Router } from "express";
import {
  createBusinessProfile,
  getBusinessProfiles,
  retrieveBusinessProfile,
  updateBusinessProfile,
} from "../controllers/businessProfile.controller";
import { authenticateToken } from "../middlewares/auth.middleware";

const businessProfileRouts = Router();

businessProfileRouts.use(authenticateToken);

businessProfileRouts.post("/", createBusinessProfile);

businessProfileRouts.put("/:id", updateBusinessProfile);

businessProfileRouts.get("/", getBusinessProfiles);

businessProfileRouts.post("/:id/retrieve", retrieveBusinessProfile);

export default businessProfileRouts;
