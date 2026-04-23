import { Router } from "express";
import {
  createBusinessProfile,
  deleteBusinessProfile,
  getBusinessProfiles,
  retrieveBusinessProfile,
  updateBusinessProfile,
  uploadLogo,
} from "../controllers/businessProfile.controller";
import { authenticateToken } from "../middlewares/auth.middleware";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

const businessProfileRouts = Router();

businessProfileRouts.use(authenticateToken);

businessProfileRouts.post("/", createBusinessProfile);

businessProfileRouts.put("/:id", updateBusinessProfile);

businessProfileRouts.delete("/:id", deleteBusinessProfile);

businessProfileRouts.get("/", getBusinessProfiles);

businessProfileRouts.post("/:id/retrieve", retrieveBusinessProfile);

businessProfileRouts.post("/logo", upload.single("logo"), uploadLogo);

export default businessProfileRouts;
