import type { Database } from "./db.js";
import { normalizePhone } from "./domain.js";

export type LeadFilters = { scopeId?: string; id?: number; query?: string; ownerId?: string; sourceId?: number; status?: string; priority?: string; attention?: string; page?: number; limit?: number };
type AttentionRules = { newLeadHours:number;inactiveLeadHours:number;flagMissingFollowUp:boolean;flagUnassigned:boolean };
const defaultAttentionRules:AttentionRules={newLeadHours:24,inactiveLeadHours:72,flagMissingFollowUp:true,flagUnassigned:true};

async function getAttentionRules(db:Database):Promise<AttentionRules>{
  const result=await db.query<{value:unknown}>("SELECT value FROM settings WHERE key='attentionRules'");
  const raw=result.rows[0]?.value;
  if(!raw||typeof raw!=="object")return defaultAttentionRules;
  const value=raw as Partial<AttentionRules>;
  const newLeadHours=Number(value.newLeadHours);const inactiveLeadHours=Number(value.inactiveLeadHours);
  return {newLeadHours:Number.isFinite(newLeadHours)&&newLeadHours>0?newLeadHours:24,inactiveLeadHours:Number.isFinite(inactiveLeadHours)&&inactiveLeadHours>0?inactiveLeadHours:72,flagMissingFollowUp:value.flagMissingFollowUp!==false,flagUnassigned:value.flagUnassigned!==false};
}

export async function getLeadList(db: Database, filters: LeadFilters = {}) {
  const values: unknown[] = [];
  const where = ["l.is_deleted = FALSE"];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };

  if (filters.scopeId) where.push(`l.assigned_user_id = ${add(filters.scopeId)}`);
  if (filters.id) where.push(`l.id = ${add(filters.id)}`);
  if (filters.query?.trim()) {
    const raw = filters.query.trim().toLowerCase();
    const phone = normalizePhone(filters.query);
    const textParam = add(`%${raw}%`);
    const phoneParam = add(phone ? `%${phone}%` : "__no_phone_match__");
    where.push(`(LOWER(l.name) LIKE ${textParam} OR LOWER(COALESCE(l.email,'')) LIKE ${textParam} OR LOWER(COALESCE(l.notes,'')) LIKE ${textParam} OR LOWER(l.interest) LIKE ${textParam} OR COALESCE(l.normalized_phone,'') LIKE ${phoneParam} OR l.id IN (SELECT search_note.lead_id FROM lead_notes search_note WHERE LOWER(search_note.note) LIKE ${textParam}))`);
  }
  if (filters.ownerId === "unassigned") where.push("l.assigned_user_id IS NULL");
  else if (filters.ownerId) where.push(`l.assigned_user_id = ${add(filters.ownerId)}`);
  if (filters.sourceId) where.push(`l.source_id = ${add(filters.sourceId)}`);
  if (filters.status) where.push(`l.status = ${add(filters.status)}`);
  if (filters.priority) where.push(`l.priority = ${add(filters.priority)}`);
  if (filters.attention === "overdue") where.push("l.next_follow_up_at < NOW() AND l.status<>'Won' AND l.status<>'Lost'");
  if (filters.attention === "today") {const start=new Date();start.setHours(0,0,0,0);const end=new Date(start.getTime()+86400000);where.push(`l.next_follow_up_at >= ${add(start)} AND l.next_follow_up_at < ${add(end)} AND l.status<>'Won' AND l.status<>'Lost'`);}
  if (filters.attention === "upcoming") {const start=new Date();start.setHours(0,0,0,0);where.push(`l.next_follow_up_at >= ${add(new Date(start.getTime()+86400000))} AND l.status<>'Won' AND l.status<>'Lost'`);}
  if (filters.attention === "no-follow-up") where.push("l.next_follow_up_at IS NULL AND l.status<>'Won' AND l.status<>'Lost'");
  if (filters.attention === "unassigned") where.push("l.assigned_user_id IS NULL AND l.status<>'Won' AND l.status<>'Lost'");
  if (filters.attention === "neglected") {
    const rules=await getAttentionRules(db);const reasons=["l.next_follow_up_at < NOW()"];
    reasons.push(`(l.status='New' AND COALESCE(l.last_interaction_at,l.created_at) < ${add(new Date(Date.now()-rules.newLeadHours*3600000))})`);
    reasons.push(`(l.status<>'New' AND COALESCE(l.last_interaction_at,l.created_at) < ${add(new Date(Date.now()-rules.inactiveLeadHours*3600000))})`);
    if(rules.flagMissingFollowUp)reasons.push("l.next_follow_up_at IS NULL");
    if(rules.flagUnassigned)reasons.push("l.assigned_user_id IS NULL");
    where.push(`l.status<>'Won' AND l.status<>'Lost' AND (${reasons.join(" OR ")})`);
  }

  const page = Math.max(1, Number.isSafeInteger(filters.page) ? filters.page! : 1);
  const limit = Math.min(200, Math.max(1, filters.limit ?? 100));
  const count = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM leads l WHERE ${where.join(" AND ")}`, values);
  const limitParam = add(limit);
  const offsetParam = add((page - 1) * limit);
  const result = await db.query<Record<string, unknown>>(
    `SELECT l.*, s.name AS source_name, u.display_name AS owner_name, creator.display_name AS created_by_name,
            lr.name AS lost_reason_name,
            MAX(l.created_at,
              COALESCE((SELECT MAX(created_at) FROM lead_notes WHERE lead_id=l.id), l.created_at),
              COALESCE((SELECT MAX(created_at) FROM lead_interactions WHERE lead_id=l.id AND type IN ('call','whatsapp','email') AND summary NOT LIKE '%action opened from the lead profile.%'),l.created_at),
              COALESCE((SELECT MAX(changed_at) FROM lead_status_history WHERE lead_id=l.id),l.created_at)
            ) AS meaningful_activity,
            (SELECT MIN(created_at) FROM lead_interactions WHERE lead_id=l.id AND type IN ('call','whatsapp','email') AND summary NOT LIKE '%action opened from the lead profile.%' AND (type<>'call' OR outcome='Answered')) AS first_contact_at
       FROM leads l
       JOIN lead_sources s ON s.id = l.source_id
       JOIN users creator ON creator.id = l.created_by
       LEFT JOIN users u ON u.id = l.assigned_user_id
       LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
      WHERE ${where.join(" AND ")}
      ORDER BY CASE WHEN l.status IN ('Won','Lost') THEN 1 ELSE 0 END, l.updated_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );

  const attentionRules = await getSettings(db);
  const ids = result.rows.map((row) => Number(row.id));
  const timelineByLead = new Map<number, unknown[]>();
  if (ids.length) {
    const idPlaceholders = ids.map((_, index) => `$${index + 1}`).join(",");
    const [people, companySetting] = await Promise.all([
      db.query<{ id:string;display_name:string }>("SELECT id,display_name FROM users"),
      db.query<{ value:unknown }>("SELECT value FROM settings WHERE key='company'"),
    ]);
    const peopleById = new Map(people.rows.map((person) => [person.id, person.display_name]));
    const rawCompany = companySetting.rows[0]?.value;
    const timelineTimezone = rawCompany && typeof rawCompany === "object" && typeof (rawCompany as { timezone?:unknown }).timezone === "string"
      ? (rawCompany as { timezone:string }).timezone : "Asia/Dubai";
    const formatFollowUp = (value:unknown) => {
      if (value == null || value === "") return "Not scheduled";
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return "Not scheduled";
      try { return new Intl.DateTimeFormat("en-AE", { dateStyle:"medium", timeStyle:"short", timeZone:timelineTimezone }).format(date); }
      catch { return new Intl.DateTimeFormat("en-AE", { dateStyle:"medium", timeStyle:"short", timeZone:"Asia/Dubai" }).format(date); }
    };
    const timeline = await db.query<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT n.lead_id, n.created_at AS occurred_at, 'note'::text AS type, 'Note added'::text AS title, n.note AS detail, u.display_name AS author,
                NULL::text AS field_changed,NULL::text AS old_value,NULL::text AS new_value
           FROM lead_notes n JOIN users u ON u.id=n.user_id WHERE n.lead_id IN (${idPlaceholders})
         UNION ALL
         SELECT h.lead_id, h.changed_at, 'status', 'Status changed', COALESCE(h.old_status || ' → ','') || h.new_status, u.display_name,
                NULL,NULL,NULL
           FROM lead_status_history h JOIN users u ON u.id=h.changed_by WHERE h.lead_id IN (${idPlaceholders})
         UNION ALL
         SELECT i.lead_id, i.created_at, i.type,
                CASE i.type WHEN 'call' THEN 'Call interaction' WHEN 'whatsapp' THEN 'WhatsApp interaction'
                  WHEN 'email' THEN 'Email interaction' WHEN 'meeting' THEN 'Meeting interaction'
                  WHEN 'viewing' THEN 'Viewing interaction' ELSE 'Interaction' END,
                i.summary, u.display_name,NULL,NULL,NULL
           FROM lead_interactions i JOIN users u ON u.id=i.user_id
          WHERE i.lead_id IN (${idPlaceholders})
            AND NOT (i.type IN ('viewing','meeting') AND i.summary LIKE '% scheduled for %')
         UNION ALL
         SELECT t.lead_id, t.created_at, 'task', 'Task created', t.title, u.display_name,NULL,NULL,NULL
           FROM tasks t JOIN users u ON u.id=t.created_by WHERE t.lead_id IN (${idPlaceholders})
         UNION ALL
         SELECT t.lead_id, t.completed_at, 'task', 'Task completed', t.title, u.display_name,NULL,NULL,NULL
           FROM tasks t JOIN users u ON u.id=t.created_by WHERE t.lead_id IN (${idPlaceholders}) AND t.completed_at IS NOT NULL
         UNION ALL
         SELECT e.lead_id,e.created_at,e.event_type,e.title,'Appointment scheduled',u.display_name,NULL,NULL,NULL
           FROM calendar_events e JOIN users u ON u.id=e.created_by WHERE e.lead_id IN (${idPlaceholders})
         UNION ALL
         SELECT CAST(a.entity_id AS BIGINT),a.timestamp,
                CASE a.field_changed WHEN 'assigned_user_id' THEN 'assignment' WHEN 'next_follow_up_at' THEN 'followup' ELSE 'update' END,
                CASE a.field_changed WHEN 'assigned_user_id' THEN 'Assignment changed' WHEN 'next_follow_up_at' THEN 'Follow-up changed' WHEN 'priority' THEN 'Priority changed' ELSE 'Lead updated' END,
                NULL,a.user_name,a.field_changed,a.old_value,a.new_value
           FROM audit_logs a
          WHERE a.entity_type='lead' AND CAST(a.entity_id AS BIGINT) IN (${idPlaceholders})
            AND a.field_changed IN ('assigned_user_id','next_follow_up_at','priority')
       ) timeline ORDER BY occurred_at DESC`, ids);
    for (const item of timeline.rows) {
      const id = Number(item.lead_id);
      const items = timelineByLead.get(id) ?? [];
      let detail=item.detail;
      if(item.field_changed==="assigned_user_id")detail=`${peopleById.get(String(item.old_value))??"Unassigned"} → ${peopleById.get(String(item.new_value))??"Unassigned"}`;
      else if(item.field_changed==="next_follow_up_at")detail=`${formatFollowUp(item.old_value)} → ${formatFollowUp(item.new_value)}`;
      else if(item.field_changed==="priority")detail=`${item.old_value??"—"} → ${item.new_value??"—"}`;
      items.push({ time: new Date(String(item.occurred_at)).toISOString(), type: item.type, title: item.title, detail, author: item.author });
      timelineByLead.set(id, items);
    }
  }

  return {
    items: result.rows.map((row) => ({
      id: Number(row.id), reference: `LEAD-${String(row.id).padStart(6, "0")}`, version: Number(row.version),
      name: row.name ?? "Unnamed lead", phone: row.phone ?? "", email: row.email ?? "", sourceId: Number(row.source_id), source: row.source_name ?? "Unknown",
      interest: row.interest ?? "", budget: row.budget == null ? null : Number(row.budget), notes: row.notes ?? "",
      propertyType: row.property_type??'', preferredLocation:row.preferred_location??'', bedrooms:row.bedrooms==null?null:Number(row.bedrooms),
      budgetMin:row.budget_min==null?null:Number(row.budget_min),budgetMax:row.budget_max==null?null:Number(row.budget_max),
      furnishedPreference:row.furnished_preference??'',moveInDate:row.move_in_date??'',
      firstContactAt:row.first_contact_at??null,
      stale:attentionRules.attentionRules?.highlightStale!==false && !['Won','Lost'].includes(String(row.status)) && Date.now()-Date.parse(String(row.meaningful_activity))>=72*3600000,
      assignedUserId: row.assigned_user_id ?? null, owner: row.owner_name ?? "Unassigned", status: row.status, priority: row.priority,
      followUp: row.next_follow_up_at ? new Date(String(row.next_follow_up_at)).toISOString() : null,
      lastActivityAt: new Date(String(row.meaningful_activity)).toISOString(),
      createdAt: new Date(String(row.created_at)).toISOString(), createdBy: row.created_by_name,
      wonAt: row.won_at ? new Date(String(row.won_at)).toISOString() : null, wonAmount: row.won_amount == null ? null : Number(row.won_amount), closingNote: row.closing_note ?? "",
      lostAt: row.lost_at ? new Date(String(row.lost_at)).toISOString() : null, lostReasonId: row.lost_reason_id == null ? null : Number(row.lost_reason_id), lostReason: row.lost_reason_name ?? "", lostNote: row.lost_note ?? "",
      timeline: timelineByLead.get(Number(row.id)) ?? [],
    })),
    page, limit, total: count.rows[0]?.count ?? 0,
  };
}

export async function getTasks(db: Database, scopeId?: string) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT t.*, l.name AS lead_name, u.display_name AS owner_name, creator.display_name AS created_by_name
       FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id JOIN users u ON u.id=t.assigned_user_id JOIN users creator ON creator.id=t.created_by
      WHERE (t.lead_id IS NULL OR l.is_deleted=FALSE)
        AND ($1 IS NULL OR (t.assigned_user_id=$1 AND (t.lead_id IS NULL OR l.assigned_user_id=$1)))
      ORDER BY t.is_completed, t.due_at`, [scopeId??null],
  );
  return result.rows.map((row) => ({ id:Number(row.id), version:Number(row.version), title:row.title, leadId:row.lead_id==null?null:Number(row.lead_id), lead:row.lead_name??"No related lead", dueAt:new Date(String(row.due_at)).toISOString(), assignedUserId:row.assigned_user_id, owner:row.owner_name, notes:row.notes??"", done:Boolean(row.is_completed), completedAt:row.completed_at?new Date(String(row.completed_at)).toISOString():null, createdBy:row.created_by_name, createdAt:new Date(String(row.created_at)).toISOString() }));
}

export async function getEmployees(db: Database, includeInactive = true) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT u.id,u.first_name,u.last_name,u.display_name,u.email,u.phone,COALESCE(u.account_role,u.role) AS role,u.own_leads_only,u.is_active,u.version,u.created_at,u.updated_at,
            COUNT(l.id) FILTER (WHERE l.is_deleted=FALSE AND l.status<>'Won' AND l.status<>'Lost')::int AS active_leads,
            COUNT(l.id) FILTER (WHERE l.is_deleted=FALSE AND l.status<>'Won' AND l.status<>'Lost' AND l.next_follow_up_at < NOW())::int AS overdue_leads,
            COUNT(l.id) FILTER (WHERE l.is_deleted=0 AND l.status='New') AS new_leads,
            COUNT(l.id) FILTER (WHERE l.is_deleted=0 AND l.status NOT IN ('Won','Lost') AND NOT EXISTS (SELECT 1 FROM lead_interactions i WHERE i.lead_id=l.id AND i.type IN ('call','whatsapp','email') AND i.summary NOT LIKE '%action opened from the lead profile.%' AND (i.type<>'call' OR i.outcome='Answered'))) AS uncontacted_leads,
            (SELECT COUNT(*) FROM tasks t WHERE t.assigned_user_id=u.id AND t.is_completed=0 AND t.due_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','+4 hours','start of day','+1 day','-4 hours')) AS tasks_due
       FROM users u LEFT JOIN leads l ON l.assigned_user_id=u.id
      WHERE u.normalized_email NOT IN ('qa-admin@example.test','qa-sales@example.test')
      ${includeInactive ? "" : "AND u.is_active=TRUE"}
      GROUP BY u.id,u.first_name,u.last_name,u.display_name,u.email,u.phone,u.role,u.is_active,u.version,u.created_at,u.updated_at
      ORDER BY u.is_active DESC,u.display_name`,
  );
  return result.rows.map((row) => ({ id:row.id, firstName:row.first_name, lastName:row.last_name, displayName:row.display_name, email:row.email, phone:row.phone??"", role:row.role, ownLeadsOnly:Boolean(row.own_leads_only), newLeads:Number(row.new_leads),uncontactedLeads:Number(row.uncontacted_leads),tasksDue:Number(row.tasks_due), isActive:Boolean(row.is_active), version:Number(row.version), activeLeads:Number(row.active_leads), overdueLeads:Number(row.overdue_leads), createdAt:new Date(String(row.created_at)).toISOString(), updatedAt:new Date(String(row.updated_at)).toISOString() }));
}

export async function getSettings(db: Database) {
  const result = await db.query<{ key: string; value: Record<string, unknown> }>("SELECT key,value FROM settings");
  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

export async function getCalendarEvents(db:Database, scopeId?:string){
  const result=await db.query<Record<string,unknown>>(`SELECT e.id,e.lead_id,e.title,e.event_type,e.starts_at,e.ends_at,e.assigned_user_id,e.created_at,
    l.name AS lead_name,u.display_name AS owner_name,creator.display_name AS created_by_name
    FROM calendar_events e JOIN leads l ON l.id=e.lead_id JOIN users u ON u.id=e.assigned_user_id JOIN users creator ON creator.id=e.created_by
    WHERE l.is_deleted=FALSE AND ($1 IS NULL OR l.assigned_user_id=$1) ORDER BY e.starts_at`, [scopeId??null]);
  return result.rows.map((row)=>({id:Number(row.id),leadId:Number(row.lead_id),lead:row.lead_name,title:row.title,eventType:row.event_type,startsAt:new Date(String(row.starts_at)).toISOString(),endsAt:row.ends_at?new Date(String(row.ends_at)).toISOString():null,assignedUserId:row.assigned_user_id,owner:row.owner_name,createdBy:row.created_by_name,createdAt:new Date(String(row.created_at)).toISOString()}));
}

export async function getDashboard(db: Database, scopeId?: string) {
  const todayStart=new Date();todayStart.setHours(0,0,0,0);const tomorrow=new Date(todayStart.getTime()+86400000);
  const rules=await getAttentionRules(db);const neglectedReasons=["next_follow_up_at<NOW()",`(status='New' AND COALESCE(last_interaction_at,created_at)<$1)`,`(status<>'New' AND COALESCE(last_interaction_at,created_at)<$2)`];
  if(rules.flagMissingFollowUp)neglectedReasons.push("next_follow_up_at IS NULL");if(rules.flagUnassigned)neglectedReasons.push("assigned_user_id IS NULL");
  const activeStatuses="('New','Contacted','Qualified','Viewing / Meeting','Follow-up')";
  const lead = await db.query<Record<string, number>>(`SELECT
    COALESCE(SUM(CASE WHEN status IN ${activeStatuses} AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS active,
    COALESCE(SUM(CASE WHEN status='New' AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS new,
    COALESCE(SUM(CASE WHEN assigned_user_id IS NULL AND status IN ${activeStatuses} AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS unassigned,
    COALESCE(SUM(CASE WHEN next_follow_up_at < NOW() AND status IN ${activeStatuses} AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS overdue,
    COALESCE(SUM(CASE WHEN next_follow_up_at IS NULL AND status IN ${activeStatuses} AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS no_follow_up,
    COALESCE(SUM(CASE WHEN status IN ${activeStatuses} AND is_deleted=FALSE AND (${neglectedReasons.join(" OR ")}) THEN 1 ELSE 0 END),0)::int AS neglected,
    COALESCE(SUM(CASE WHEN status='Won' AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS won,
    COALESCE(SUM(CASE WHEN status='Lost' AND is_deleted=FALSE THEN 1 ELSE 0 END),0)::int AS lost
    FROM leads WHERE ($3 IS NULL OR assigned_user_id=$3)`, [new Date(Date.now()-rules.newLeadHours*3600000),new Date(Date.now()-rules.inactiveLeadHours*3600000),scopeId??null]);
  const tasks = await db.query<Record<string, number>>("SELECT COALESCE(SUM(CASE WHEN is_completed=FALSE AND due_at<NOW() THEN 1 ELSE 0 END),0)::int AS overdue, COALESCE(SUM(CASE WHEN is_completed=FALSE AND due_at>=$1 AND due_at<$2 THEN 1 ELSE 0 END),0)::int AS today FROM tasks WHERE ($3 IS NULL OR (assigned_user_id=$3 AND (lead_id IS NULL OR lead_id IN (SELECT id FROM leads WHERE assigned_user_id=$3 AND is_deleted=0))))",[todayStart,tomorrow,scopeId??null]);
  const stages = await db.query<{ status: string; count: number }>("SELECT status,COUNT(*)::int AS count FROM leads WHERE is_deleted=FALSE AND ($1 IS NULL OR assigned_user_id=$1) GROUP BY status",[scopeId??null]);
  const followUpsToday = await db.query<{ count:number }>("SELECT COUNT(*)::int AS count FROM leads WHERE is_deleted=FALSE AND next_follow_up_at>=$1 AND next_follow_up_at<$2 AND status<>'Won' AND status<>'Lost' AND ($3 IS NULL OR assigned_user_id=$3)",[todayStart,tomorrow,scopeId??null]);
  const viewingsToday = await db.query<{ count:number }>("SELECT COUNT(*)::int AS count FROM calendar_events WHERE event_type='viewing' AND starts_at>=$1 AND starts_at<$2 AND ($3 IS NULL OR lead_id IN (SELECT id FROM leads WHERE assigned_user_id=$3 AND is_deleted=0))",[todayStart,tomorrow,scopeId??null]);
  const row = lead.rows[0] ?? {};
  const closed = Number(row.won??0)+Number(row.lost??0);
  return { ...row, tasksOverdue:tasks.rows[0]?.overdue??0,tasksToday:tasks.rows[0]?.today??0,followUpsToday:followUpsToday.rows[0]?.count??0,viewingsToday:viewingsToday.rows[0]?.count??0,conversionRate:closed?Math.round((Number(row.won??0)/closed)*100):0,stages:Object.fromEntries(stages.rows.map((item)=>[item.status,item.count])) };
}

export async function getReports(db: Database) {
  const sources = await db.query<{ name:string; count:number }>("SELECT s.name,COUNT(l.id)::int AS count FROM lead_sources s LEFT JOIN leads l ON l.source_id=s.id AND l.is_deleted=FALSE GROUP BY s.id,s.name ORDER BY count DESC,s.name");
  const employees = await db.query<Record<string, unknown>>(`SELECT u.id,u.display_name,
    COUNT(l.id)::int AS assigned,
    COUNT(l.id) FILTER (WHERE l.status='Contacted')::int AS contacted,
    COUNT(l.id) FILTER (WHERE l.status<>'Won' AND l.status<>'Lost')::int AS active,
    COUNT(l.id) FILTER (WHERE l.next_follow_up_at<NOW() AND l.status<>'Won' AND l.status<>'Lost')::int AS overdue,
    COUNT(l.id) FILTER (WHERE l.status='Won')::int AS won,
    COUNT(l.id) FILTER (WHERE l.status='Lost')::int AS lost
    FROM users u LEFT JOIN leads l ON l.assigned_user_id=u.id AND l.is_deleted=FALSE
    WHERE u.normalized_email NOT IN ('qa-admin@example.test','qa-sales@example.test')
    GROUP BY u.id,u.display_name ORDER BY u.display_name`);
  const lostReasons = await db.query<{ name:string; count:number }>("SELECT r.name,COUNT(l.id)::int AS count FROM lost_reasons r LEFT JOIN leads l ON l.lost_reason_id=r.id AND l.is_deleted=FALSE GROUP BY r.id,r.name ORDER BY count DESC,r.name");
  const responseTimes = await db.query<Record<string,unknown>>(`WITH contacts AS (
    SELECT l.id,l.assigned_user_id,l.created_at,
      (SELECT MIN(i.created_at) FROM lead_interactions i WHERE i.lead_id=l.id AND i.type IN ('call','whatsapp','email') AND i.summary NOT LIKE '%action opened from the lead profile.%' AND (i.type<>'call' OR i.outcome='Answered')) AS first_contact
    FROM leads l WHERE l.is_deleted=0
  ) SELECT u.id,u.display_name,COUNT(c.id) AS total,
    COUNT(c.first_contact) AS contacted,
    AVG(CASE WHEN c.first_contact IS NOT NULL THEN MAX(0,(julianday(c.first_contact)-julianday(c.created_at))*1440) END) AS average_minutes
    FROM users u LEFT JOIN contacts c ON c.assigned_user_id=u.id
    WHERE u.normalized_email NOT IN ('qa-admin@example.test','qa-sales@example.test')
    GROUP BY u.id,u.display_name ORDER BY u.display_name`);
  return { responseTimes:responseTimes.rows, sources:sources.rows, employees:employees.rows.map((row)=>{const closed=Number(row.won)+Number(row.lost);return {...row,conversionRate:closed?Math.round(Number(row.won)/closed*100):0}}), lostReasons:lostReasons.rows };
}
