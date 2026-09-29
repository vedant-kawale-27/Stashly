-- Add device metadata fields used by the current Device model.
ALTER TABLE "Device" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'android';
ALTER TABLE "Device" ADD COLUMN "osVersion" TEXT;
ALTER TABLE "Device" ADD COLUMN "appVersion" TEXT;
