-- Group classes: a session can seat more than one student, and who is in it
-- moves out of ClassSession.studentId into a row per seat.

-- CreateTable
CREATE TABLE "SessionParticipant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "SessionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_studentId_key" ON "SessionParticipant"("sessionId", "studentId");
CREATE INDEX "SessionParticipant_studentId_idx" ON "SessionParticipant"("studentId");

-- AddForeignKey
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionParticipant" ADD CONSTRAINT "SessionParticipant_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN "capacity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ClassSession" ADD COLUMN "seatPriceCents" INTEGER;

-- Backfill before the column goes: every existing class keeps its one student
-- as its one seat, with the time they first entered the room preserved.
INSERT INTO "SessionParticipant" ("id", "sessionId", "studentId", "bookedAt", "joinedAt")
SELECT gen_random_uuid()::text, s."id", s."studentId", s."createdAt", s."joinedAt"
FROM "ClassSession" s;

-- DropForeignKey / DropIndex / AlterTable
ALTER TABLE "ClassSession" DROP CONSTRAINT "ClassSession_studentId_fkey";
DROP INDEX "ClassSession_studentId_startsAt_idx";
ALTER TABLE "ClassSession" DROP COLUMN "studentId";

-- CreateIndex
CREATE INDEX "ClassSession_startsAt_idx" ON "ClassSession"("startsAt");
