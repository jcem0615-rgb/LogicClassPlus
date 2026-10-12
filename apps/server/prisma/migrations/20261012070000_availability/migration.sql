-- Teaching hours.
--
-- Until now any time was bookable: a student could ask for 3am, and the only
-- thing standing between a teacher and a 3am lesson was the teacher noticing
-- and declining it. A teacher now says when they teach, and the server holds
-- the line.
--
-- Weekday and minutes are stored rather than timestamps because the rule is
-- recurring and local: "Monday 09:00–17:00" means Monday where the teacher
-- is, whatever that instant happens to be in UTC, and it keeps meaning that
-- across a daylight-saving change.
--
-- No rows are created here, and no rows are required: a teacher with no
-- windows counts as available whenever. This migration therefore changes the
-- behaviour of nothing until somebody fills their hours in.

CREATE TABLE "Availability" (
  "id"          TEXT NOT NULL,
  "teacherId"   TEXT NOT NULL,
  "weekday"     INTEGER NOT NULL,
  "startMinute" INTEGER NOT NULL,
  "endMinute"   INTEGER NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Availability_teacherId_weekday_idx" ON "Availability"("teacherId", "weekday");

-- CASCADE: a teacher's hours are meaningless without the teacher.
ALTER TABLE "Availability"
  ADD CONSTRAINT "Availability_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
