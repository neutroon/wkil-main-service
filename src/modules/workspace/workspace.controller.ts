import { Router } from "express";
import {
  createWorkspace,
  renameWorkspace,
  getWorkspace,
  listMembers,
  inviteMember,
  acceptInvite,
  removeMember,
  leaveWorkspace,
  deleteWorkspace,
} from "./workspace.service";

const workspaceController = Router();

// All routes are behind authenticateToken + requireVerified + validateCsrfToken
// (mounted in app.ts after those middlewares)

// POST /v1/workspace — create new workspace
workspaceController.post("/", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name_required" });
  }

  try {
    const result = await createWorkspace(userId, name);
    res.status(201).json(result);
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "create_failed" });
  }
});

// GET /v1/workspace/:id — get workspace details
workspaceController.get("/:id", async (req, res) => {
  const userId = Number((req as any).user?.id);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  try {
    const workspace = await getWorkspace(userId, workspaceId);
    res.json(workspace);
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "get_failed" });
  }
});

// PATCH /v1/workspace/:id — rename workspace
workspaceController.patch("/:id", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name_required" });
  }

  try {
    await renameWorkspace(userId, workspaceId, name);
    res.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "rename_failed" });
  }
});

// GET /v1/workspace/:id/members — list members
workspaceController.get("/:id/members", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  try {
    const members = await listMembers(userId, workspaceId);
    res.json({ members });
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "list_failed" });
  }
});

// POST /v1/workspace/:id/invite — send invitation
workspaceController.post("/:id/invite", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  const { email, role } = req.body ?? {};
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email_required" });
  }

  try {
    const result = await inviteMember(userId, workspaceId, email, role);
    res.status(201).json(result);
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "invite_failed" });
  }
});

// POST /v1/workspace/invite/accept — accept invitation (body: { token })
workspaceController.post("/invite/accept", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { token } = req.body ?? {};
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "token_required" });
  }

  try {
    const result = await acceptInvite(token, userId);
    res.json(result);
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "accept_failed" });
  }
});

// DELETE /v1/workspace/:id/members/:memberId — remove member or self (leave)
workspaceController.delete("/:id/members/:memberId", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0 ||
      !Number.isFinite(memberId) || memberId <= 0) {
    return res.status(400).json({ error: "invalid_id" });
  }

  try {
    await removeMember(userId, workspaceId, memberId);
    res.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "remove_failed" });
  }
});

// POST /v1/workspace/:id/leave — leave workspace
workspaceController.post("/:id/leave", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  try {
    await leaveWorkspace(userId, workspaceId);
    res.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "leave_failed" });
  }
});

// DELETE /v1/workspace/:id — delete workspace
workspaceController.delete("/:id", async (req, res) => {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const workspaceId = Number(req.params.id);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    return res.status(400).json({ error: "invalid_workspace_id" });
  }

  const { confirmationName } = req.body ?? {};
  if (typeof confirmationName !== "string" || !confirmationName.trim()) {
    return res.status(400).json({ error: "confirmation_required" });
  }

  try {
    await deleteWorkspace(userId, workspaceId, confirmationName);
    res.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    res.status(status).json({ error: e?.message ?? "delete_failed" });
  }
});

export default workspaceController;
