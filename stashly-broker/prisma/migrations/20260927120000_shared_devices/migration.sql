-- Convert the original one-user-per-device model into the shared-device model.
-- Existing device owners are preserved as owner links in UserDevice.

CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "UserDevice" ("id", "userId", "deviceId", "role", "createdAt")
SELECT
    "id",
    "userId",
    "id",
    'owner',
    "createdAt"
FROM "Device";

CREATE UNIQUE INDEX "UserDevice_userId_deviceId_key" ON "UserDevice"("userId", "deviceId");
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");
CREATE INDEX "UserDevice_deviceId_idx" ON "UserDevice"("deviceId");
