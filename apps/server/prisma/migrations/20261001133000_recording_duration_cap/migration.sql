-- A recording that nobody stops has to be stoppable by the server, which
-- means knowing when it started.
ALTER TABLE "ClassSession" ADD COLUMN "recordingStartedAt" TIMESTAMP(3);
