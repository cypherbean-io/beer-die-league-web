-- Custom SQL migration file, put your code below! --
-- audit_events is append-only (SPEC §3.3). Revoking grants alone wouldn't bind the
-- database owner, which dev and tests connect as, so statement triggers refuse every
-- UPDATE and DELETE (including ones that match no rows) and every TRUNCATE (including one
-- that cascades from leagues or memberships). A superuser can still disable triggers, so
-- production must also connect as a role that is neither owner nor superuser.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
