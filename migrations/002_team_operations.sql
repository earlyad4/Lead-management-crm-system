ALTER TABLE users ADD COLUMN account_role TEXT CHECK (account_role IS NULL OR account_role IN ('Administrator','Manager','Reception','Sales Employee'));
-- statement-breakpoint
ALTER TABLE users ADD COLUMN own_leads_only INTEGER NOT NULL DEFAULT 1 CHECK (own_leads_only IN (0,1));
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN property_type TEXT;
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN preferred_location TEXT;
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN bedrooms INTEGER CHECK (bedrooms IS NULL OR bedrooms >= 0);
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN budget_min NUMERIC CHECK (budget_min IS NULL OR budget_min >= 0);
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN budget_max NUMERIC CHECK (budget_max IS NULL OR budget_max >= 0);
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN furnished_preference TEXT;
-- statement-breakpoint
ALTER TABLE leads ADD COLUMN move_in_date TEXT;
-- statement-breakpoint
ALTER TABLE lead_interactions ADD COLUMN outcome TEXT;
-- statement-breakpoint
CREATE TABLE assignment_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  assigned_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged_at TEXT
);
-- statement-breakpoint
CREATE INDEX assignment_notifications_pending ON assignment_notifications(user_id, acknowledged_at);
-- statement-breakpoint
CREATE INDEX interactions_lead_contact ON lead_interactions(lead_id, type, created_at);
-- statement-breakpoint
INSERT INTO lost_reasons(name) VALUES ('Property unavailable'),('Chose another agency'),('Not ready') ON CONFLICT(name) DO NOTHING;
-- statement-breakpoint
UPDATE lost_reasons SET is_active=0 WHERE name IN ('Price','Not interested','Competitor','Requirement unavailable','Timing');
-- statement-breakpoint
INSERT INTO settings(key,value) VALUES ('messageTemplates', '[{"id":"first","name":"First response","body":"Hello {name}, thank you for contacting Example Company about {interest}. I am {employee}. When would be a good time to discuss your requirements?"},{"id":"property","name":"Property information","body":"Hello {name}, here are the details for {interest} in {location}. Your budget range is {budget}. Please let me know what you think."},{"id":"confirmation","name":"Viewing confirmation","body":"Hello {name}, confirming your viewing of {interest} on {viewing}. I am {employee} from Example Company. Please reply to confirm."},{"id":"reminder","name":"Viewing reminder","body":"Hello {name}, a reminder about your viewing of {interest} on {viewing}. Please let me know if you need to reschedule."},{"id":"documents","name":"Document request","body":"Hello {name}, to proceed with {interest}, please let me know when you are available to discuss the required documents. Thank you, {employee}, Example Company."},{"id":"followup","name":"Follow-up after viewing","body":"Hello {name}, thank you for viewing {interest}. How did you find the property? I would be happy to answer any questions. {employee}, Example Company."}]') ON CONFLICT(key) DO NOTHING;
-- statement-breakpoint
UPDATE settings SET value=json_set(value,'$.highlightStale',json('true')) WHERE key='attentionRules';
