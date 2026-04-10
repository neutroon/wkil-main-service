-- CreateTable
CREATE TABLE "public"."AiUsageStat" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsageStat_businessProfileId_idx" ON "public"."AiUsageStat"("businessProfileId");

-- CreateIndex
CREATE INDEX "AiUsageStat_date_idx" ON "public"."AiUsageStat"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageStat_businessProfileId_date_key" ON "public"."AiUsageStat"("businessProfileId", "date");

-- AddForeignKey
ALTER TABLE "public"."AiUsageStat" ADD CONSTRAINT "AiUsageStat_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
