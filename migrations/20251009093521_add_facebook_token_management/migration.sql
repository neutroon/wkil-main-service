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
CREATE UNIQUE INDEX "FacebookAccount_facebookUserId_key" ON "public"."FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE INDEX "FacebookAccount_userId_idx" ON "public"."FacebookAccount"("userId");

-- CreateIndex
CREATE INDEX "FacebookAccount_facebookUserId_idx" ON "public"."FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE INDEX "FacebookPage_pageId_idx" ON "public"."FacebookPage"("pageId");

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
ALTER TABLE "public"."FacebookAccount" ADD CONSTRAINT "FacebookAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookPage" ADD CONSTRAINT "FacebookPage_facebookAccountId_fkey" FOREIGN KEY ("facebookAccountId") REFERENCES "public"."FacebookAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookActivity" ADD CONSTRAINT "FacebookActivity_facebookAccountId_fkey" FOREIGN KEY ("facebookAccountId") REFERENCES "public"."FacebookAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FacebookActivity" ADD CONSTRAINT "FacebookActivity_facebookPageId_fkey" FOREIGN KEY ("facebookPageId") REFERENCES "public"."FacebookPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserAnalytics" ADD CONSTRAINT "UserAnalytics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
