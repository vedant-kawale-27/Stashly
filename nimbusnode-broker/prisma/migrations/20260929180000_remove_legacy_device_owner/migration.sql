-- Ownership is now represented by UserDevice; remove the legacy required owner column.
ALTER TABLE "Device" DROP CONSTRAINT IF EXISTS "Device_userId_fkey";
DROP INDEX IF EXISTS "Device_userId_idx";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "userId";
