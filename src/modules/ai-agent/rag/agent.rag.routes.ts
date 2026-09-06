import { Router } from "express";

import {
  beginRagRefresh,
  commitRagRefresh,
  getActiveRagRevision,
} from "./agent.rag.service";

const agentRagRoutes = Router();

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

agentRagRoutes.use((req, res, next) => {
  const token = process.env.MONOLITH_SERVICE_TOKEN ?? "";
  if (!token || req.header("x-service-token") !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

agentRagRoutes.post("/:businessProfileId/revisions", async (req, res) => {
  const businessProfileId = positiveInteger(req.params.businessProfileId);
  if (businessProfileId === null) {
    return res.status(400).json({ error: "invalid_business_profile_id" });
  }
  try {
    return res.json(await beginRagRefresh(businessProfileId));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "rag_snapshot_failed" });
  }
});

agentRagRoutes.post("/:businessProfileId/revisions/:revision/commit", async (req, res) => {
  const businessProfileId = positiveInteger(req.params.businessProfileId);
  const revision = positiveInteger(req.params.revision);
  if (businessProfileId === null || revision === null) {
    return res.status(400).json({ error: "invalid_rag_revision" });
  }
  try {
    return res.json(await commitRagRefresh(businessProfileId, revision));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "rag_publish_failed" });
  }
});

agentRagRoutes.get("/:businessProfileId/active-revision", async (req, res) => {
  const businessProfileId = positiveInteger(req.params.businessProfileId);
  if (businessProfileId === null) {
    return res.status(400).json({ error: "invalid_business_profile_id" });
  }
  try {
    return res.json(await getActiveRagRevision(businessProfileId));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? "rag_revision_lookup_failed" });
  }
});

export default agentRagRoutes;
