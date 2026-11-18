-- CreateIndex
CREATE INDEX "AuditLog_at_id_idx" ON "AuditLog"("at", "id");

-- CreateIndex
CREATE INDEX "AuditLog_midName_at_id_idx" ON "AuditLog"("midName", "at", "id");
