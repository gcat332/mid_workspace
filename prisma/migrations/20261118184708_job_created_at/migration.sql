-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "midId" TEXT,
    "midName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "params" TEXT NOT NULL,
    "journalPath" TEXT NOT NULL,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Job" ("attempt", "createdBy", "error", "finishedAt", "id", "journalPath", "kind", "midId", "midName", "params", "stage", "startedAt", "status", "updatedAt") SELECT "attempt", "createdBy", "error", "finishedAt", "id", "journalPath", "kind", "midId", "midName", "params", "stage", "startedAt", "status", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_midName_status_idx" ON "Job"("midName", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
