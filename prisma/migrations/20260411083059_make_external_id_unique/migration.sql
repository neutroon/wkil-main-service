/*
  Warnings:

  - A unique constraint covering the columns `[externalId]` on the table `ConversationMessage` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_externalId_key" ON "public"."ConversationMessage"("externalId");
