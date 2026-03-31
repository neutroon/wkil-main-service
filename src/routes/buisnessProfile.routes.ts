import { Router } from "express";
import {
  createBusinessProfile,
  deleteBusinessProfile,
  getBusinessProfiles,
  retrieveBusinessProfile,
  updateBusinessProfile,
} from "../controllers/businessProfile.controller";
import { authenticateToken } from "../middlewares/auth.middleware";

const businessProfileRouts = Router();

businessProfileRouts.use(authenticateToken);

businessProfileRouts.post("/", createBusinessProfile);

businessProfileRouts.put("/:id", updateBusinessProfile);

businessProfileRouts.delete("/:id", deleteBusinessProfile);

businessProfileRouts.get("/", getBusinessProfiles);

businessProfileRouts.post("/:id/retrieve", retrieveBusinessProfile);

export default businessProfileRouts;
