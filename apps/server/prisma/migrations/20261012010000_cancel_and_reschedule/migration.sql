-- Cancelling and moving a class.
--
-- `SessionStatus` has carried CANCELLED since the first migration and nothing
-- could ever set it. These columns are what it was missing: who called the
-- class off, when, and why — and, for a class that moved, the time it moved
-- away from, so "rescheduled from Tuesday 16:00" can be read off the row.
--
-- Every column is nullable and no existing row changes, so this is additive:
-- the classes already in the table are, correctly, neither cancelled nor
-- moved.

ALTER TABLE "ClassSession"
  ADD COLUMN "cancelledAt"     TIMESTAMP(3),
  ADD COLUMN "cancelledById"   TEXT,
  ADD COLUMN "cancelReason"    TEXT,
  ADD COLUMN "rescheduledFrom" TIMESTAMP(3),
  ADD COLUMN "rescheduledAt"   TIMESTAMP(3);

-- SET NULL, not CASCADE: removing the administrator who cancelled a class
-- must not take the class, its chat and its invoice lines with it.
ALTER TABLE "ClassSession"
  ADD CONSTRAINT "ClassSession_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The Owner's class monitor asks "what was called off this week", which is a
-- scan of a column that is null for almost every row.
CREATE INDEX "ClassSession_cancelledAt_idx" ON "ClassSession"("cancelledAt");
