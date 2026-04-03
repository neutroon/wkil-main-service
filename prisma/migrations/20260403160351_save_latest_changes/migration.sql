-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "public"."User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "facebookUserId" TEXT,
    "facebookAccessToken" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isBusinessProfileCreated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "voice" TEXT NOT NULL DEFAULT 'Professional',
    "tone" TEXT NOT NULL DEFAULT 'Friendly',
    "productsServices" TEXT[],
    "expectedUserIntents" TEXT[],
    "corePolicies" TEXT NOT NULL,
    "phoneNumbers" TEXT[],
    "workingHours" TEXT,
    "address" TEXT,
    "scrapedWebsiteUrl" TEXT,
    "scrapedMarkdown" TEXT,
    "ragIngested" BOOLEAN NOT NULL DEFAULT false,
    "ragIngestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExternalDataSource" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "headers" JSONB,
    "queryParams" JSONB,
    "expectedParamsSchema" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessProfileFaq" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "BusinessProfileFaq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessProfileChunk" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "chunkType" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfileChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CrmIntegration" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKey" TEXT,
    "webhookUrl" TEXT,
    "fieldMapping" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Conversation" (
    "id" SERIAL NOT NULL,
    "pageId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "channel" TEXT,
    "customerPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConversationMessage" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcessedMessengerMessage" (
    "id" SERIAL NOT NULL,
    "messageMid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessengerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcessedWhatsAppMessage" (
    "id" SERIAL NOT NULL,
    "wamid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WhatsAppAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "businessProfileId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserManagement" (
    "id" SERIAL NOT NULL,
    "managerId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserManagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Lead" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "url" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "public"."FacebookAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "facebookUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL DEFAULT 'bearer',
    "expiresAt" TIMESTAMP(3),
    "refreshToken" TEXT,
    "scope" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "deviceInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FacebookPage" (
    "id" SERIAL NOT NULL,
    "facebookAccountId" INTEGER NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageName" TEXT NOT NULL,
    "pageAccessToken" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "businessProfileId" INTEGER,

    CONSTRAINT "FacebookPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FacebookActivity" (
    "id" SERIAL NOT NULL,
    "facebookAccountId" INTEGER NOT NULL,
    "facebookPageId" INTEGER,
    "activityType" TEXT NOT NULL,
    "activityData" JSONB,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserAnalytics" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postsCreated" INTEGER NOT NULL DEFAULT 0,
    "postsScheduled" INTEGER NOT NULL DEFAULT 0,
    "commentsReplied" INTEGER NOT NULL DEFAULT 0,
    "pagesConnected" INTEGER NOT NULL DEFAULT 0,
    "totalEngagement" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_facebookUserId_key" ON "public"."User"("facebookUserId");

-- CreateIndex
CREATE INDEX "ExternalDataSource_businessProfileId_idx" ON "public"."ExternalDataSource"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProfileFaq_businessId_idx" ON "public"."BusinessProfileFaq"("businessId");

-- CreateIndex
CREATE INDEX "BusinessProfileChunk_businessProfileId_idx" ON "public"."BusinessProfileChunk"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProfileChunk_businessProfileId_chunkType_idx" ON "public"."BusinessProfileChunk"("businessProfileId", "chunkType");

-- CreateIndex
CREATE INDEX "CrmIntegration_businessProfileId_idx" ON "public"."CrmIntegration"("businessProfileId");

-- CreateIndex
CREATE INDEX "Conversation_pageId_senderId_idx" ON "public"."Conversation"("pageId", "senderId");

-- CreateIndex
CREATE INDEX "Conversation_pageId_senderId_updatedAt_idx" ON "public"."Conversation"("pageId", "senderId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_channel_idx" ON "public"."Conversation"("channel");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_idx" ON "public"."ConversationMessage"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_createdAt_idx" ON "public"."ConversationMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedMessengerMessage_messageMid_key" ON "public"."ProcessedMessengerMessage"("messageMid");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWhatsAppMessage_wamid_key" ON "public"."ProcessedWhatsAppMessage"("wamid");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_userId_idx" ON "public"."WhatsAppAccount"("userId");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_phoneNumberId_idx" ON "public"."WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_businessProfileId_idx" ON "public"."WhatsAppAccount"("businessProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_userId_phoneNumberId_key" ON "public"."WhatsAppAccount"("userId", "phoneNumberId");

-- CreateIndex
CREATE INDEX "UserManagement_managerId_idx" ON "public"."UserManagement"("managerId");

-- CreateIndex
CREATE INDEX "UserManagement_userId_idx" ON "public"."UserManagement"("userId");

-- CreateIndex
CREATE INDEX "UserManagement_assignedBy_idx" ON "public"."UserManagement"("assignedBy");

-- CreateIndex
CREATE UNIQUE INDEX "UserManagement_managerId_userId_key" ON "public"."UserManagement"("managerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_email_key" ON "public"."Lead"("email");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookAccount_facebookUserId_key" ON "public"."FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE INDEX "FacebookAccount_userId_idx" ON "public"."FacebookAccount"("userId");

-- CreateIndex
CREATE INDEX "FacebookAccount_facebookUserId_idx" ON "public"."FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE INDEX "FacebookPage_pageId_idx" ON "public"."FacebookPage"("pageId");

-- CreateIndex
CREATE INDEX "FacebookPage_businessProfileId_idx" ON "public"."FacebookPage"("businessProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPage_facebookAccountId_pageId_key" ON "public"."FacebookPage"("facebookAccountId", "pageId");

-- CreateIndex
CREATE INDEX "FacebookActivity_facebookAccountId_idx" ON "public"."FacebookActivity"("facebookAccountId");

-- CreateIndex
CREATE INDEX "FacebookActivity_activityType_idx" ON "public"."FacebookActivity"("activityType");

-- CreateIndex
CREATE INDEX "FacebookActivity_createdAt_idx" ON "public"."FacebookActivity"("createdAt");

-- CreateIndex
CREATE INDEX "UserAnalytics_userId_idx" ON "public"."UserAnalytics"("userId");

-- CreateIndex
CREATE INDEX "UserAnalytics_date_idx" ON "public"."UserAnalytics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "UserAnalytics_userId_date_key" ON "public"."UserAnalytics"("userId", "date");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalDataSource" ADD CONSTRAINT "ExternalDataSource_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileFaq" ADD CONSTRAINT "BusinessProfileFaq_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileChunk" ADD CONSTRAINT "BusinessProfileChunk_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CrmIntegration" ADD CONSTRAINT "CrmIntegration_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_assignedBy_fkey" FOREIGN KEY ("assignedBy") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookAccount" ADD CONSTRAINT "FacebookAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookPage" ADD CONSTRAINT "FacebookPage_facebookAccountId_fkey" FOREIGN KEY ("facebookAccountId") REFERENCES "public"."FacebookAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookPage" ADD CONSTRAINT "FacebookPage_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookActivity" ADD CONSTRAINT "FacebookActivity_facebookAccountId_fkey" FOREIGN KEY ("facebookAccountId") REFERENCES "public"."FacebookAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookActivity" ADD CONSTRAINT "FacebookActivity_facebookPageId_fkey" FOREIGN KEY ("facebookPageId") REFERENCES "public"."FacebookPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserAnalytics" ADD CONSTRAINT "UserAnalytics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
