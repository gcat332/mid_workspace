-- The MidHub IdP/OIDC sign-in and its admin page are gone (sign-in is through AgentHub), but the old page stored the
-- IdP client secret in plaintext in IdpConfig.clientSecret, with no UI left to clear it. Delete the rows rather
-- than blank the column: no table or foreign key references IdpConfig (single-row settings table), nothing in this
-- version reads it, and a rollback to the previous version handles a missing row (SSO off, configurable again).
-- Data only: the table stays, so the schema and a rollback are unaffected. Idempotent.
-- If an IdP client was configured for MidHub, also delete or rotate that client in the IdP itself.
DELETE FROM "IdpConfig";
