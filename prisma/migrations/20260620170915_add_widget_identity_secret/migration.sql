-- AlterTable
ALTER TABLE "WidgetInstall" ADD COLUMN "identitySecret" TEXT NOT NULL DEFAULT '';

-- Populate existing rows with unique secrets before adding unique index
UPDATE "WidgetInstall" SET "identitySecret" = MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) WHERE "identitySecret" = '';

-- CreateIndex
CREATE UNIQUE INDEX "WidgetInstall_identitySecret_key" ON "WidgetInstall"("identitySecret");
