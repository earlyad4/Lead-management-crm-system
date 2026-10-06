import type { AuthUser } from './auth.js';
import type { DatabaseClient } from './db.js';

type Reader = Pick<DatabaseClient, 'query'>;
export const isManagement = (user: AuthUser) => user.role === 'Administrator' || user.role === 'Manager';
export const leadScope = (user: AuthUser) => user.role === 'Sales Employee' && user.ownLeadsOnly !== false ? user.id : undefined;
export const fail = (message: string, statusCode = 403) => Object.assign(new Error(message), {statusCode});

export async function requireLeadAccess(db: Reader, user: AuthUser, id: number) {
  const result = await db.query<Record<string, unknown>>('SELECT * FROM leads WHERE id=$1 AND is_deleted=0', [id]);
  const row = result.rows[0];
  if (!row || (leadScope(user) && row.assigned_user_id !== user.id)) throw fail('Lead not found.', 404);
  return row;
}

export async function validateAssignment(db: Reader, user: AuthUser, owner: string | null | undefined, creating = false) {
  if (!owner) {
    if (leadScope(user)) throw fail('Assign the lead to yourself.');
    return;
  }
  if (user.role === 'Sales Employee' && owner !== user.id) throw fail('Sales employees may assign leads only to themselves.');
  const result = await db.query<{role:string}>("SELECT COALESCE(account_role,role) AS role FROM users WHERE id=$1 AND is_active=1", [owner]);
  const target = result.rows[0];
  if (!target) throw fail('Select an active employee.', 400);
  if (target.role === 'Administrator') throw fail('Administrator accounts cannot own leads.', 400);
  if (target.role === 'Manager' && !(creating && user.role === 'Manager' && owner === user.id)) {
    throw fail('Management may take ownership only when creating their own lead.', 400);
  }
}

export async function notifyAssignment(db: Reader, user: AuthUser, leadId: number, owner: unknown) {
  // Old assignments cease to be actionable; retain the records for history.
  await db.query('UPDATE assignment_notifications SET acknowledged_at=NOW() WHERE lead_id=$1 AND acknowledged_at IS NULL', [leadId]);
  if (typeof owner === 'string') await db.query('INSERT INTO assignment_notifications(user_id,lead_id,assigned_by) VALUES($1,$2,$3)', [owner,leadId,user.id]);
}
