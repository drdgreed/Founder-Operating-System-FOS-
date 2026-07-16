-- Append-only guard for operational_event (spec §9.7 "Append-only event
-- used for audit, metrics, projections, and downstream workflows"; spec
-- §17.8 "Hard deletion of audit history is prohibited through standard
-- interfaces"). Direct UPDATE or DELETE on this table raises at the DB
-- layer, independent of any application-layer discipline.

CREATE OR REPLACE FUNCTION operational_event_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'operational_event is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER operational_event_no_update
  BEFORE UPDATE ON "operational_event"
  FOR EACH ROW EXECUTE FUNCTION operational_event_append_only();
--> statement-breakpoint
CREATE TRIGGER operational_event_no_delete
  BEFORE DELETE ON "operational_event"
  FOR EACH ROW EXECUTE FUNCTION operational_event_append_only();
