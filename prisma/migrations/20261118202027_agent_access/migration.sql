-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MidServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "instanceId" TEXT,
    "dir" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "heapMb" INTEGER NOT NULL DEFAULT 1024,
    "version" TEXT,
    "state" TEXT NOT NULL DEFAULT 'installed',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    "agentAccess" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_MidServer" ("createdAt", "createdBy", "dir", "heapMb", "id", "instanceId", "name", "removedAt", "serviceName", "state", "version") SELECT "createdAt", "createdBy", "dir", "heapMb", "id", "instanceId", "name", "removedAt", "serviceName", "state", "version" FROM "MidServer";
DROP TABLE "MidServer";
ALTER TABLE "new_MidServer" RENAME TO "MidServer";
CREATE UNIQUE INDEX "MidServer_name_key" ON "MidServer"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
