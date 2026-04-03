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

-- CreateIndex
CREATE INDEX "UserManagement_managerId_idx" ON "public"."UserManagement"("managerId");

-- CreateIndex
CREATE INDEX "UserManagement_userId_idx" ON "public"."UserManagement"("userId");

-- CreateIndex
CREATE INDEX "UserManagement_assignedBy_idx" ON "public"."UserManagement"("assignedBy");

-- CreateIndex
CREATE UNIQUE INDEX "UserManagement_managerId_userId_key" ON "public"."UserManagement"("managerId", "userId");

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserManagement" ADD CONSTRAINT "UserManagement_assignedBy_fkey" FOREIGN KEY ("assignedBy") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
