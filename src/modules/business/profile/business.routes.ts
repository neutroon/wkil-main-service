import { Router } from "express";
import {
  createBusinessProfile,
  deleteBusinessProfile,
  getBusinessProfiles,
  retrieveBusinessProfile,
  updateBusinessProfile,
  uploadLogo,
} from "./business.controller";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { businessProfileSchema, updateBusinessProfileSchema } from "./business.validation";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

const businessProfileRouts = Router();

businessProfileRouts.use(authenticateToken);

businessProfileRouts.post("/", validate(businessProfileSchema), createBusinessProfile);

businessProfileRouts.put("/:id", validate(updateBusinessProfileSchema), updateBusinessProfile);

businessProfileRouts.delete("/:id", deleteBusinessProfile);

businessProfileRouts.get("/", getBusinessProfiles);

businessProfileRouts.post("/:id/retrieve", retrieveBusinessProfile);

businessProfileRouts.post("/logo", upload.single("logo"), uploadLogo);

export default businessProfileRouts;







