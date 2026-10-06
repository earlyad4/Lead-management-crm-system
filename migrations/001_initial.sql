CREATE TABLE users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('Administrator', 'Manager', 'Sales Employee')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE lead_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE lost_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  normalized_phone TEXT,
  email TEXT,
  normalized_email TEXT,
  source_id INTEGER NOT NULL REFERENCES lead_sources(id) ON DELETE RESTRICT,
  interest TEXT NOT NULL,
  budget NUMERIC CHECK (budget IS NULL OR budget >= 0),
  notes TEXT NOT NULL DEFAULT '',
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Contacted','Qualified','Viewing / Meeting','Follow-up','Won','Lost')),
  priority TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent')),
  next_follow_up_at TEXT,
  last_interaction_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  won_at TEXT,
  won_amount NUMERIC CHECK (won_amount IS NULL OR won_amount >= 0),
  closing_note TEXT,
  lost_at TEXT,
  lost_reason_id INTEGER REFERENCES lost_reasons(id) ON DELETE RESTRICT,
  lost_note TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  deleted_at TEXT,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- statement-breakpoint
CREATE TABLE lead_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE lead_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('call','whatsapp','email','meeting','viewing','system')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE lead_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  due_at TEXT NOT NULL,
  assigned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notes TEXT NOT NULL DEFAULT '',
  is_completed INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0,1)),
  completed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('follow-up','task','viewing','meeting')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_changed TEXT,
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
);

-- statement-breakpoint
CREATE TABLE login_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  normalized_email TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- statement-breakpoint
CREATE INDEX leads_status_idx ON leads(status) WHERE is_deleted = 0;
-- statement-breakpoint
CREATE INDEX leads_assigned_user_idx ON leads(assigned_user_id) WHERE is_deleted = 0;
-- statement-breakpoint
CREATE INDEX leads_follow_up_idx ON leads(next_follow_up_at) WHERE is_deleted = 0;
-- statement-breakpoint
CREATE INDEX leads_normalized_phone_idx ON leads(normalized_phone) WHERE normalized_phone IS NOT NULL;
-- statement-breakpoint
CREATE INDEX leads_normalized_email_idx ON leads(normalized_email) WHERE normalized_email IS NOT NULL;
-- statement-breakpoint
CREATE INDEX leads_source_idx ON leads(source_id) WHERE is_deleted = 0;
-- statement-breakpoint
CREATE INDEX leads_created_at_idx ON leads(created_at DESC);
-- statement-breakpoint
CREATE INDEX tasks_assigned_due_idx ON tasks(assigned_user_id, due_at) WHERE is_completed = 0;
-- statement-breakpoint
CREATE INDEX tasks_lead_idx ON tasks(lead_id);
-- statement-breakpoint
CREATE INDEX audit_logs_timestamp_idx ON audit_logs(timestamp DESC);
-- statement-breakpoint
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, timestamp DESC);
-- statement-breakpoint
CREATE INDEX sessions_token_idx ON sessions(token_hash);

-- statement-breakpoint
INSERT INTO lead_sources (name) VALUES
  ('Instagram'),('Facebook'),('Website'),('Referral'),('Phone Call'),('Walk-in'),('Property Portal'),('WhatsApp'),('Google'),('Other')
ON CONFLICT (name) DO NOTHING;

-- statement-breakpoint
INSERT INTO lost_reasons (name) VALUES
  ('Price'),('No response'),('Not interested'),('Competitor'),('Budget mismatch'),('Requirement unavailable'),('Timing'),('Duplicate'),('Other')
ON CONFLICT (name) DO NOTHING;

-- statement-breakpoint
INSERT INTO settings (key, value) VALUES
  ('company', '{"companyName":"Example Company","timezone":"Asia/Dubai","currency":"AED","internalUrl":"http://crm.company.local"}'),
  ('attentionRules', '{"newLeadHours":24,"inactiveLeadHours":72,"flagMissingFollowUp":true,"flagUnassigned":true}')
ON CONFLICT (key) DO NOTHING;
