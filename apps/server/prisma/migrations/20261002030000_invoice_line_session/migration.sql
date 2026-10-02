-- Which class an invoice line charges for, so "already billed" is decided by
-- the class rather than by the text of the line.
ALTER TABLE "InvoiceLine" ADD COLUMN "sessionId" TEXT;
CREATE INDEX "InvoiceLine_sessionId_idx" ON "InvoiceLine"("sessionId");
