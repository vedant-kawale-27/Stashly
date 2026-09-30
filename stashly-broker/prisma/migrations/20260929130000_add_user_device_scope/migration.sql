-- Add a separate file-access scope for every client linked to a device.
ALTER TABLE "UserDevice" ADD COLUMN "scopeMode" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "UserDevice" ADD COLUMN "scopePath" TEXT;
ALTER TABLE "UserDevice" ADD COLUMN "scopeName" TEXT;
