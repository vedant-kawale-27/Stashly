ALTER TABLE "FileEntry" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "FileVersion" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT,
    "encryptedDek" TEXT NOT NULL,
    "cacheKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "encryptedDek" TEXT NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FileEntry_deviceId_deletedAt_idx" ON "FileEntry"("deviceId", "deletedAt");
CREATE INDEX "FileVersion_fileId_createdAt_idx" ON "FileVersion"("fileId", "createdAt");
CREATE INDEX "FileVersion_deviceId_idx" ON "FileVersion"("deviceId");
CREATE INDEX "UploadSession_userId_deviceId_idx" ON "UploadSession"("userId", "deviceId");
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
