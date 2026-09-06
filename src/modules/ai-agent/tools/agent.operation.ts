import type { RequestHandler } from "express";
import { createHash } from "node:crypto";
import prisma from "@config/prisma";

// Deliberately no automatic expiry/retry of PENDING claims: a provider might
// have accepted a send before the process lost its connection or crashed.
export const durableAgentOperation: RequestHandler = async (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // Website analysis only fetches and parses public source content; it does
  // not mutate Wkil state. Keep it callable during profile-less onboarding
  // without manufacturing an idempotency claim for a read operation.
  if (req.path === "/onboarding/analyze") return next();
  const operationId = req.header("x-agent-operation-id");
  const userId = Number(req.body?.userId);
  const requestedBusinessProfileId = req.body?.businessProfileId ?? req.body?.args?.businessProfileId;
  const businessProfileId = requestedBusinessProfileId == null ? null : Number(requestedBusinessProfileId);
  if (!operationId || !/^[a-zA-Z0-9:_-]{1,200}$/.test(operationId) || !Number.isSafeInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "operation_id_and_user_required" }); return;
  }
  const id = createHash("sha256").update(`${userId}:${businessProfileId}:${operationId}`).digest("hex");
  const requestHash = createHash("sha256").update(JSON.stringify([req.method, req.originalUrl, req.body])).digest("hex");
  try {
    await prisma.agentOperation.create({ data: { id, userId, businessProfileId, requestHash } });
  } catch (error: any) {
    if (error?.code !== "P2002") { res.status(503).json({ error: "operation_store_unavailable" }); return; }
    const existing = await prisma.agentOperation.findUnique({ where: { id } }).catch(() => null);
    if (!existing || existing.requestHash !== requestHash) { res.status(409).json({ error: "operation_conflict" }); return; }
    if (existing.status !== "COMPLETED") { res.status(409).json({ error: "operation_requires_reconciliation" }); return; }
    res.status(existing.statusCode ?? 200).json(existing.result); return;
  }
  const sendJson = res.json.bind(res);
  let recording = false;
  res.json = ((body: unknown) => {
    if (recording) return res;
    recording = true;
    const statusCode = res.statusCode;
    // Persist before acknowledging. Any failed handler may have performed a
    // partial effect; record its error too, rather than rerun on HTTP retry.
    prisma.agentOperation.update({ where: { id }, data: {
      status: "COMPLETED", statusCode, result: JSON.parse(JSON.stringify(body ?? null)),
    } }).then(() => { sendJson(body); }).catch(() => {
      res.status(503); sendJson({ error: "operation_requires_reconciliation" });
    });
    return res;
  }) as typeof res.json;
  next();
};
