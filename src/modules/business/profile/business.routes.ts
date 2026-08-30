import { Router } from "express";
import {
  createBusinessProfile,
  deleteBusinessProfile,
  getBusinessProfiles,
  previewBusinessProfileChat,
  retrieveBusinessProfile,
  updateBusinessProfile,
  uploadLogo,
} from "./business.controller";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { AppError } from "@middlewares/errorHandler.middleware";
import { businessProfileSchema, updateBusinessProfileSchema } from "./business.validation";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
} from "./knowledge.service";
import prisma from "@config/prisma";
import { z } from "zod";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

const businessProfileRouts = Router();

businessProfileRouts.use(authenticateToken);

// Public dashboard-facing knowledge document routes.
// NOTE: /:id/documents must be registered before any conflicting /:id patterns.
businessProfileRouts.get("/:id/documents", validate(z.object({ params: z.object({ id: z.coerce.number() }) })), async (req, res, next) => {
  try {
    const profile = await prisma.businessProfile.findFirst({ where: { id: Number(req.params.id), userId: (req as any).user.id } });
    if (!profile) throw new AppError("Business profile not found.", 404);
    res.json({ data: await listKnowledgeDocuments(profile.id, {
      kind: req.query.kind ? String(req.query.kind) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }) });
  } catch (e) { next(e); }
});

businessProfileRouts.post("/:id/documents", async (req, res, next) => {
  try {
    const profile = await prisma.businessProfile.findFirst({ where: { id: Number(req.params.id), userId: (req as any).user.id } });
    if (!profile) throw new AppError("Business profile not found.", 404);
    res.status(201).json({ data: await createKnowledgeDocument(profile.id, req.body ?? {}) });
  } catch (e) { next(e); }
});

businessProfileRouts.put("/documents/:docId", async (req, res, next) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id: Number(req.params.docId), businessProfile: { userId: (req as any).user.id } } });
    if (!doc) throw new AppError("Knowledge document not found.", 404);
    res.json({ data: await updateKnowledgeDocument(doc.businessProfileId, doc.id, req.body ?? {}) });
  } catch (e) { next(e); }
});

businessProfileRouts.delete("/documents/:docId", async (req, res, next) => {
  try {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id: Number(req.params.docId), businessProfile: { userId: (req as any).user.id } } });
    if (!doc) throw new AppError("Knowledge document not found.", 404);
    res.json({ data: await deleteKnowledgeDocument(doc.businessProfileId, doc.id) });
  } catch (e) { next(e); }
});

businessProfileRouts.post("/", validate(businessProfileSchema), createBusinessProfile);

businessProfileRouts.put("/:id", validate(updateBusinessProfileSchema), updateBusinessProfile);

businessProfileRouts.delete("/:id", deleteBusinessProfile);

businessProfileRouts.get("/", getBusinessProfiles);

businessProfileRouts.post("/:id/retrieve", retrieveBusinessProfile);

businessProfileRouts.post("/:id/preview-chat", previewBusinessProfileChat);

businessProfileRouts.post("/logo", upload.single("logo"), uploadLogo);

export default businessProfileRouts;







