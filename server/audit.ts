import type { DatabaseClient } from "./db.js";
import type { AuthUser } from "./auth.js";

export type AuditEntry = {
  user: AuthUser;
  action: string;
  entityType: string;
  entityId: string | number;
  fieldChanged?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
};

const auditValue = (value: unknown) => value == null ? null : typeof value === 'string' ? value : JSON.stringify(value, (key, item) => /password|token|secret/i.test(key) ? '[redacted]' : item);

export async function writeAudit(client: Pick<DatabaseClient, "query">, entry: AuditEntry) {
  await client.query(
    `INSERT INTO audit_logs (user_id,user_name,action,entity_type,entity_id,field_changed,old_value,new_value,ip_address,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [entry.user.id, entry.user.displayName, entry.action, entry.entityType, String(entry.entityId), entry.fieldChanged ?? null,
      auditValue(entry.oldValue), auditValue(entry.newValue), entry.ipAddress ?? null, JSON.stringify(entry.metadata ?? {})],
  );
}
