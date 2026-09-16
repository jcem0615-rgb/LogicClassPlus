-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "recordingBytes" BIGINT,
ADD COLUMN     "recordingEgressId" TEXT,
ADD COLUMN     "recordingSeconds" INTEGER;
