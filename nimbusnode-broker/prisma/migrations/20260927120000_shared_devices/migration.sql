-- Convert the original one-user-per-device model into the shared-device model.
-- Existing device owners are preserved as owner links in UserDevice.
PRAGMA foreign_keys=OFF;

CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "UserDevice" ("id", "userId", "deviceId", "role", "createdAt")
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
    "userId",
    "id",
    'owner',
    "createdAt"
FROM "Device";

CREATE UNIQUE INDEX "UserDevice_userId_deviceId_key" ON "UserDevice"("userId", "deviceId");
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");
CREATE INDEX "UserDevice_deviceId_idx" ON "UserDevice"("deviceId");

CREATE TABLE "Device_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "osVersion" TEXT,
    "appVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" DATETIME,
    "storageQuotaMb" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "Device_new" ("id", "name", "status", "lastSeenAt", "storageQuotaMb", "createdAt")
SELECT "id", "name", "status", "lastSeenAt", "storageQuotaMb", "createdAt"
FROM "Device";

DROP TABLE "Device";
ALTER TABLE "Device_new" RENAME TO "Device";

PRAGMA foreign_keys=ON;
