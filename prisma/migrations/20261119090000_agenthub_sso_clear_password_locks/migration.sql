-- MidHub sign-in moved to AgentHub (admins only); password login is gone.
-- Until now lockedAt was only ever set by the password lockout (3 wrong passwords, auto-expiring after 15 min).
-- From now on a lock is set by an admin and lasts until unlocked, so clear the old password locks once:
-- otherwise a stale password lock would become permanent. No schema change; passwordHash/failedLoginCount stay unused.
UPDATE "User" SET "lockedAt" = NULL, "failedLoginCount" = 0;
