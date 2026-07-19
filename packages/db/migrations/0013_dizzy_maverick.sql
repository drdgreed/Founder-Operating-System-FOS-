CREATE INDEX "agent_run_correlation_id_idx" ON "agent_run" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "agent_run_workspace_id_agent_key_idx" ON "agent_run" USING btree ("workspace_id","agent_key");--> statement-breakpoint
CREATE INDEX "enrollment_assessment_opportunity_id_idx" ON "enrollment_assessment" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "enrollment_assessment_agent_run_id_idx" ON "enrollment_assessment" USING btree ("agent_run_id");