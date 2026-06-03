#!/usr/bin/env node

require("ts-node/register/transpile-only");
require("tsconfig-paths/register");

const prisma = require("../src/config/prisma").default;
const {
  computeBusinessChatReply,
} = require("../src/modules/ai-agent/chat/businessChatReply.service");
const {
  startConversationAiRun,
} = require("../src/modules/ai-agent/chat/conversationRunGuard");

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function usage() {
  return [
    "Usage:",
    "  node scripts/chat-latency-smoke.js --profile-id <id> --message <text> [--channel web]",
    "    [--repeat 3] [--assert-under-ms 5000] [--require-grounded true]",
    "    [--require-chunk-type faq] [--expect-action REPLY_AUTO]",
    "    [--expect-reply-type NORMAL_REPLY] [--conversation-smoke true]",
    "",
    "Environment fallbacks:",
    "  AI_CHAT_SMOKE_PROFILE_ID",
    "  AI_CHAT_SMOKE_MESSAGE",
    "  AI_CHAT_SMOKE_CHANNEL",
  ].join("\n");
}

function readIntArg(name, fallback) {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function readBoolArg(name, fallback = false) {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

async function createConversationRun(params) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const conversation = await prisma.conversation.create({
    data: {
      businessProfileId: params.businessProfileId,
      pageId: `smoke:${params.businessProfileId}`,
      senderId: `chat-latency-smoke:${stamp}`,
      channel: params.channel,
      status: "OPEN",
      aiEnabled: true,
    },
    select: { id: true },
  });
  const message = await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: params.message,
    },
    select: { id: true, conversationId: true },
  });
  const run = await startConversationAiRun({
    conversationId: conversation.id,
    latestUserMessageId: message.id,
  });

  return {
    conversationId: conversation.id,
    latestUserMessageId: message.id,
    conversationRunId: run.runId,
  };
}

function assertResult(result, params) {
  const failures = [];
  if (result.elapsedMs > params.assertUnderMs) {
    failures.push(`elapsedMs ${result.elapsedMs} > ${params.assertUnderMs}`);
  }
  if (params.expectAction && result.action !== params.expectAction) {
    failures.push(`action ${result.action} !== ${params.expectAction}`);
  }
  if (params.expectReplyType && result.replyType !== params.expectReplyType) {
    failures.push(`replyType ${result.replyType} !== ${params.expectReplyType}`);
  }
  if (params.requireGrounded && result.grounded !== true) {
    failures.push("grounded !== true");
  }
  if (
    params.requireChunkType &&
    !result.usedChunkTypes.includes(params.requireChunkType)
  ) {
    failures.push(
      `usedChunkTypes missing ${params.requireChunkType}: ${result.usedChunkTypes.join(",")}`,
    );
  }

  return failures;
}

async function main() {
  const profileId = Number(
    readArg("--profile-id") || process.env.AI_CHAT_SMOKE_PROFILE_ID,
  );
  const message = readArg("--message") || process.env.AI_CHAT_SMOKE_MESSAGE;
  const channel =
    readArg("--channel") || process.env.AI_CHAT_SMOKE_CHANNEL || "web";
  const repeat = Math.max(1, readIntArg("--repeat", 1));
  const assertUnderMs = readIntArg("--assert-under-ms", 5000);
  const requireGrounded = readBoolArg("--require-grounded");
  const requireChunkType = readArg("--require-chunk-type");
  const expectAction = readArg("--expect-action");
  const expectReplyType = readArg("--expect-reply-type");
  const conversationSmoke = readBoolArg("--conversation-smoke");

  if (!Number.isInteger(profileId) || profileId <= 0 || !message) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { id: profileId },
    include: {
      agentActionSources: { where: { isActive: true } },
    },
  });

  if (!businessProfile) {
    throw new Error(`Business profile not found: ${profileId}`);
  }

  const results = [];
  const failures = [];
  for (let i = 0; i < repeat; i++) {
    const conversationContext = conversationSmoke
      ? await createConversationRun({
          businessProfileId: profileId,
          channel,
          message,
        })
      : {};

    const startedAt = Date.now();
    const decision = await computeBusinessChatReply({
      businessProfile,
      messageText: message,
      historyTurns: [],
      channel,
      ...conversationContext,
    });
    const elapsedMs = Date.now() - startedAt;
    const content = String(decision.content || decision.publicContent || "");
    const result = {
      runIndex: i + 1,
      profileId,
      channel,
      conversationSmoke,
      conversationId: conversationContext.conversationId,
      elapsedMs,
      underFiveSeconds: elapsedMs < 5000,
      action: decision.action,
      replyType: decision.replyType,
      requiresGrounding: decision.requiresGrounding,
      grounded: decision.grounded,
      usedChunkTypes: Array.isArray(decision.usedChunkTypes)
        ? decision.usedChunkTypes
        : [],
      contentLength: content.length,
      contentPreview: content.slice(0, 260),
    };
    const runFailures = assertResult(result, {
      assertUnderMs,
      expectAction,
      expectReplyType,
      requireGrounded,
      requireChunkType,
    });
    if (runFailures.length > 0) {
      failures.push({
        runIndex: result.runIndex,
        failures: runFailures,
      });
    }
    results.push(result);
  }

  const elapsedValues = results.map((result) => result.elapsedMs);
  const summary = {
    profileId,
    channel,
    repeat,
    assertUnderMs,
    pass: failures.length === 0,
    maxElapsedMs: Math.max(...elapsedValues),
    minElapsedMs: Math.min(...elapsedValues),
    avgElapsedMs: Math.round(
      elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length,
    ),
    failures,
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    const exitCode = process.exitCode || 0;
    setTimeout(() => process.exit(exitCode), 250);
  });
