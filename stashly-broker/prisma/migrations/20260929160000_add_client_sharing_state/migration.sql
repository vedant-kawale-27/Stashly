-- Keep each client's access scope while allowing its sharing session to be stopped.
ALTER TABLE "UserDevice" ADD COLUMN "sharingEnabled" BOOLEAN NOT NULL DEFAULT true;
