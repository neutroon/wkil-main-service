import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "@utils/logger";
import { recordPrismaQuery } from "@utils/dbQueryTrace";

const basePrisma = new PrismaClient();

const prismaWithQueryTrace = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        const startedAt = Date.now();
        try {
          return await query(args);
        } finally {
          recordPrismaQuery(Date.now() - startedAt);
        }
      },
    },
  },
});

/**
 * ELITE TIER: Automated Side-Effects Extension
 * This extension intercepts every write to 'conversationMessage' and 
 * triggers a socket emit to keep the UI perfectly in sync with the DB.
 */
const prisma = prismaWithQueryTrace.$extends({
  query: {
    conversationMessage: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);

        // Automated Message Sync (Upsert/Update/Delete)
        if (["create", "update", "upsert", "delete"].includes(operation) && result) {
          import("@modules/realtime/socketSync.service")
            .then(async ({ syncSocketFromMessage, emitToBusiness }) => {
              if (operation === "delete") {
                // For delete, we notify the UI about the removal
                const deleted = result as any;
                emitToBusiness(deleted.conversation?.businessProfileId || 0, "message_deleted", {
                  id: deleted.id,
                  conversationId: deleted.conversationId
                });
                return;
              }

              if (result && typeof result === "object" && !Array.isArray(result)) {
                let messageWithContext = result as any;
                if (
                  !messageWithContext.conversation?.businessProfileId ||
                  messageWithContext.conversation?.channel === undefined
                ) {
                  const context = await basePrisma.conversation.findUnique({
                    where: { id: messageWithContext.conversationId },
                    select: { businessProfileId: true, channel: true }
                  });
                  messageWithContext = { ...messageWithContext, conversation: context };
                }
                syncSocketFromMessage(messageWithContext);
              }
            })
            .catch((err) => logger.warn("prisma.extension.msg_sync_failed", { error: err.message }));
        }

        return result;
      },
    },
    conversation: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);

        if (["update", "upsert", "delete"].includes(operation) && result) {
          import("@modules/realtime/socketSync.service")
            .then(({ emitToBusiness }) => {
              if (result && typeof result === "object" && !Array.isArray(result)) {
                const conv = result as any;
                const eventName = operation === "delete" ? "conversation_deleted" : "conversation_updated";
                emitToBusiness(conv.businessProfileId, eventName, conv);
              }
            })
            .catch((err) => logger.warn("prisma.extension.conv_sync_failed", { error: err.message }));
        }

        return result;
      }
    }
  },
});

export default prisma;
export { Prisma };


