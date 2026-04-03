-- Idempotent processing of Meta Messenger webhook deliveries (message.mid)
CREATE TABLE "public"."ProcessedMessengerMessage" (
    "id" SERIAL NOT NULL,
    "messageMid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessengerMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessedMessengerMessage_messageMid_key" ON "public"."ProcessedMessengerMessage"("messageMid");
