-- Content-immutability guard for artifact_version (spec §12.2 "an approved
-- version is immutable; revision creates a new version"; §9.13 "Approved or
-- executed versions are immutable"). A version is an immutable CONTENT
-- snapshot: once written, body_markdown and content_hash may never change.
-- Editing content means creating a NEW version (see create-revision).
--
-- approval_status and updated_at REMAIN mutable so lifecycle transitions
-- (§12.2) can proceed. This guard is stronger than §9.13's literal
-- "approved/executed versions are immutable": it makes content immutable for
-- EVERY version regardless of status, per the build instruction and §12.2's
-- "revision creates a new version" model.

CREATE OR REPLACE FUNCTION artifact_version_content_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'artifact_version content is immutable: body_markdown/content_hash cannot change (create a new version instead)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER artifact_version_no_content_update
  BEFORE UPDATE ON "artifact_version"
  FOR EACH ROW EXECUTE FUNCTION artifact_version_content_immutable();
