-- CreateTable
CREATE TABLE "PronunciationAttempt" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT,
    "referenceText" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "recognizedText" TEXT,
    "accuracyScore" DOUBLE PRECISION,
    "fluencyScore" DOUBLE PRECISION,
    "completenessScore" DOUBLE PRECISION,
    "pronunciationScore" DOUBLE PRECISION,
    "prosodyScore" DOUBLE PRECISION,
    "durationSeconds" DOUBLE PRECISION,
    "words" JSONB,
    "provider" TEXT NOT NULL DEFAULT 'azure',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PronunciationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PronunciationAttempt_studentId_createdAt_idx" ON "PronunciationAttempt"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "PronunciationAttempt_sessionId_idx" ON "PronunciationAttempt"("sessionId");

-- AddForeignKey
ALTER TABLE "PronunciationAttempt" ADD CONSTRAINT "PronunciationAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PronunciationAttempt" ADD CONSTRAINT "PronunciationAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
