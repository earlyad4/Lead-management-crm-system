import { leadScope, isManagement, requireLeadAccess, validateAssignment, notifyAssignment, fail } from "./access.js";
import type { Role } from "./domain.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import { writeAudit } from "./audit.js";
import { authMiddleware, cookieOptions, createSession, csrfMiddleware, requireRole, SESSION_COOKIE } from "./auth.js";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { getCalendarEvents, getDashboard, getEmployees, getLeadList, getReports, getSettings, getTasks } from "./data.js";
import type { Database } from "./db.js";
import { withTransaction } from "./db.js";
import { csvCell, normalizeEmail, normalizePhone } from "./domain.js";
import { calendarEventCreateSchema, deactivateEmployeeSchema, employeeCreateSchema, employeePatchSchema, interactionSchema, leadCreateSchema, leadPatchSchema, loginSchema, noteSchema, settingsSchema, taskCreateSchema, taskPatchSchema } from "./validation.js";

const asyncHandler = (handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (request, response, next) => { void handler(request, response, next).catch(next); };

const has = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
const ip = (request: Request) => request.ip || request.socket.remoteAddress || "unknown";

export function createApp(db: Database, suppliedConfig?: AppConfig) {
  const config = suppliedConfig ?? getConfig();
  const logger = pino({ level: config.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", "res.headers['set-cookie']", "password", "token", "SESSION_SECRET"] });
  const app = express();
  if (config.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: config.NODE_ENV === "production" ? {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", "ws:", "wss:"],
      },
    } : false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.COOKIE_SECURE === "true" ? undefined : false,
  }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.get("/api/health", asyncHandler(async (_request, response) => {
    const started = Date.now();
    await db.query("SELECT 1");
    response.json({ version:"2026.09-team-operations", status: "ok", database: "connected", responseMs: Date.now() - started, time: new Date().toISOString() });
  }));

  app.use('/api', (_req,res,next)=>{if(existsSync(path.resolve('run','maintenance.lock')))return res.status(503).json({error:'The CRM is being updated. Please try again shortly.'});next();});
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many sign-in attempts. Please wait and try again." } });
  app.post("/api/auth/login", loginLimiter, asyncHandler(async (request, response) => {
    const input = loginSchema.parse(request.body);
    const email = normalizeEmail(input.email);
    const result = await db.query<{ id:string;display_name:string;email:string;role:Role;own_leads_only:number;password_hash:string;is_active:boolean }>("SELECT id,display_name,email,COALESCE(account_role,role) AS role,own_leads_only,password_hash,is_active FROM users WHERE normalized_email=$1", [email]);
    const user = result.rows[0];
    const valid = user?.is_active ? await bcrypt.compare(input.password, user.password_hash) : false;
    await db.query("INSERT INTO login_history (user_id,normalized_email,succeeded,ip_address) VALUES ($1,$2,$3,$4)", [user?.id ?? null, email, valid, ip(request)]);
    if (!user || !valid) return response.status(401).json({ error: "Email or password is incorrect." });
    await db.query("DELETE FROM sessions WHERE expires_at<=NOW()");
    const session = await createSession(db, user.id, ip(request), config.SESSION_HOURS);
    response.cookie(SESSION_COOKIE, session.rawToken, cookieOptions(config.COOKIE_SECURE === "true", session.expiresAt));
    response.json({ user:{id:user.id,displayName:user.display_name,email:user.email,role:user.role,ownLeadsOnly:Boolean(user.own_leads_only)},csrfToken:session.csrfToken });
  }));

  app.use("/api", authMiddleware(db));

  app.get("/api/auth/me", (request, response) => response.json({ user:request.auth!.user, csrfToken:request.auth!.csrfToken }));
  app.post("/api/auth/logout", csrfMiddleware, asyncHandler(async (request, response) => {
    await db.query("DELETE FROM sessions WHERE id=$1", [request.auth!.sessionId]);
    response.clearCookie(SESSION_COOKIE, { path: "/" });
    response.status(204).end();
  }));

  app.use('/api', (_req,res,next) => {res.setHeader('Cache-Control','no-store');next();});
  app.get('/api/notifications', asyncHandler(async(req,res) => {
    const result = await db.query(`SELECT n.id,n.lead_id AS leadId,n.created_at AS createdAt,l.name,l.interest,u.display_name AS assignedBy
      FROM assignment_notifications n JOIN leads l ON l.id=n.lead_id JOIN users u ON u.id=n.assigned_by
      WHERE n.user_id=$1 AND n.acknowledged_at IS NULL AND l.assigned_user_id=$1 AND l.is_deleted=0 ORDER BY n.id DESC`, [req.auth!.user.id]);
    res.json(result.rows);
  }));
  app.post('/api/notifications/:id/acknowledge', csrfMiddleware, asyncHandler(async(req,res) => {
    await db.query('UPDATE assignment_notifications SET acknowledged_at=NOW() WHERE id=$1 AND user_id=$2',[Number(req.params.id),req.auth!.user.id]);res.json({ok:true});
  }));
  app.get('/api/leads/:id', asyncHandler(async(req,res) => {
    await requireLeadAccess(db,req.auth!.user,Number(req.params.id));
    const result=await getLeadList(db,{id:Number(req.params.id),scopeId:leadScope(req.auth!.user)});res.json(result.items[0]);
  }));

  app.get("/api/bootstrap", asyncHandler(async (request, response) => {
    const scopeId=leadScope(request.auth!.user);
    const [leads,tasks,calendarEvents,employees,settings,dashboard,reports,sources,lostReasons] = await Promise.all([
      getLeadList(db,{limit:100,scopeId}), getTasks(db,scopeId), getCalendarEvents(db,scopeId), getEmployees(db,true), getSettings(db), getDashboard(db,scopeId), isManagement(request.auth!.user)?getReports(db):Promise.resolve({sources:[],employees:[],lostReasons:[],responseTimes:[]}),
      db.query("SELECT id,name,is_active FROM lead_sources ORDER BY name"), db.query("SELECT id,name,is_active FROM lost_reasons ORDER BY name"),
    ]);
    response.json({ user:request.auth!.user,csrfToken:request.auth!.csrfToken,leads,tasks,calendarEvents,employees:request.auth!.user.role==="Sales Employee"?employees.filter(e=>e.isActive&&e.role!=="Administrator"&&e.role!=="Manager").map(e=>({...e,email:"",phone:"",activeLeads:0,overdueLeads:0,newLeads:0,uncontactedLeads:0,tasksDue:0})):employees,settings,dashboard,reports,sources:sources.rows,lostReasons:lostReasons.rows });
  }));

  app.get("/api/leads", asyncHandler(async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : undefined;
    const ownerId = typeof request.query.ownerId === "string" ? request.query.ownerId : undefined;
    const sourceId = typeof request.query.sourceId === "string" ? Number(request.query.sourceId) : undefined;
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const priority = typeof request.query.priority === "string" ? request.query.priority : undefined;
    const attention = typeof request.query.attention === "string" ? request.query.attention : undefined;
    const page = typeof request.query.page === "string" ? Number(request.query.page) : 1;
    response.json(await getLeadList(db,{scopeId:leadScope(request.auth!.user),query,ownerId,sourceId:Number.isFinite(sourceId)?sourceId:undefined,status,priority,attention,page,limit:100}));
  }));

  app.post("/api/leads", csrfMiddleware, asyncHandler(async (request, response) => {
    const input = leadCreateSchema.parse(request.body);
    if (input.budgetMin!=null && input.budgetMax!=null && input.budgetMin>input.budgetMax) throw fail('Minimum budget cannot exceed maximum budget.',400);
    if (request.auth!.user.role==='Sales Employee' && !input.assignedUserId) input.assignedUserId=request.auth!.user.id;
    await validateAssignment(db,request.auth!.user,input.assignedUserId,true);
    const normalizedPhone = normalizePhone(input.phone);
    const normalizedEmail = normalizeEmail(input.email);
    if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) return response.status(400).json({ error:"Enter a valid email address." });
    const duplicate = await db.query<Record<string,unknown>>(
      `SELECT l.id,l.name,l.status,l.assigned_user_id AS owner_id FROM leads l
       WHERE l.is_deleted=FALSE AND (($1<>'' AND l.normalized_phone=$1) OR ($2<>'' AND l.normalized_email=$2)) LIMIT 1`, [normalizedPhone,normalizedEmail]);
    if(duplicate.rows[0]?.owner_id){const owner=await db.query<{display_name:string}>("SELECT display_name FROM users WHERE id=$1",[duplicate.rows[0].owner_id]);duplicate.rows[0].owner=owner.rows[0]?.display_name??"Unassigned";}
    if (duplicate.rows[0] && !input.duplicateOverride) return response.status(409).json({ error:"Possible duplicate lead.", duplicate:leadScope(request.auth!.user)&&duplicate.rows[0].owner_id!==request.auth!.user.id?{restricted:true}:duplicate.rows[0] });

    const lead = await withTransaction(db, async (client) => {
      const source=await client.query("SELECT 1 FROM lead_sources WHERE id=$1 AND is_active=TRUE",[input.sourceId]);
      if(!source.rows[0])throw Object.assign(new Error("Select an active lead source."),{statusCode:400});
      if (input.assignedUserId) {
        const owner = await client.query("SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE",[input.assignedUserId]);
        if (!owner.rows[0]) throw Object.assign(new Error("Assigned employee is not active."),{statusCode:400});
      }
      const inserted = await client.query<{id:number;version:number}>(
        `INSERT INTO leads (name,phone,normalized_phone,email,normalized_email,source_id,interest,budget,notes,assigned_user_id,priority,next_follow_up_at,created_by,last_interaction_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) RETURNING id,version`,
        [input.name,input.phone||null,normalizedPhone||null,input.email||null,normalizedEmail||null,input.sourceId,input.interest,input.budget??null,input.notes,input.assignedUserId,input.priority,input.nextFollowUpAt??null,request.auth!.user.id]);
      const row = inserted.rows[0];
      await client.query('UPDATE leads SET property_type=$1,preferred_location=$2,bedrooms=$3,budget_min=$4,budget_max=$5,furnished_preference=$6,move_in_date=$7 WHERE id=$8', [input.propertyType??null,input.preferredLocation??null,input.bedrooms??null,input.budgetMin??null,input.budgetMax??null,input.furnishedPreference??null,input.moveInDate??null,row.id]);
      await notifyAssignment(client,request.auth!.user,row.id,input.assignedUserId);
      await client.query("INSERT INTO lead_status_history (lead_id,old_status,new_status,changed_by) VALUES ($1,NULL,'New',$2)",[row.id,request.auth!.user.id]);
      if (input.notes) await client.query("INSERT INTO lead_notes (lead_id,user_id,note) VALUES ($1,$2,$3)",[row.id,request.auth!.user.id,input.notes]);
      await writeAudit(client,{user:request.auth!.user,action:"Lead created",entityType:"lead",entityId:row.id,newValue:{name:input.name,status:"New"},ipAddress:ip(request),metadata:{duplicateOverride:Boolean(duplicate.rows[0])}});
      return row;
    });
    response.status(201).json({ id:lead.id,version:lead.version });
  }));

  app.patch("/api/leads/:id", csrfMiddleware, asyncHandler(async (request, response) => {
    const leadId = Number(request.params.id);
    if (!Number.isSafeInteger(leadId) || leadId < 1) return response.status(400).json({ error:"Invalid lead identifier." });
    await requireLeadAccess(db,request.auth!.user,leadId);
    const input = leadPatchSchema.parse(request.body);
    const updated = await withTransaction(db, async (client) => {
      const locked = await client.query<Record<string,unknown>>("SELECT * FROM leads WHERE id=$1 AND is_deleted=FALSE FOR UPDATE",[leadId]);
      const current = locked.rows[0];
      if (!current || (leadScope(request.auth!.user)&&current.assigned_user_id!==request.auth!.user.id)) throw Object.assign(new Error("Lead not found."),{statusCode:404});
      if (Number(current.version)!==input.version) throw Object.assign(new Error("This lead was changed by another user. Refresh before saving."),{statusCode:409,code:"STALE_UPDATE"});
      if(has(input,'assignedUserId')&&input.assignedUserId!==current.assigned_user_id) await validateAssignment(client,request.auth!.user,input.assignedUserId);
      const min=has(input,'budgetMin')?input.budgetMin:current.budget_min; const max=has(input,'budgetMax')?input.budgetMax:current.budget_max;
      if(min!=null&&max!=null&&Number(min)>Number(max)) throw fail('Minimum budget cannot exceed maximum budget.',400);
      const resultingPhone=has(input,"phone")?input.phone:current.phone;const resultingEmail=has(input,"email")?input.email:current.email;
      if(!resultingPhone&&!resultingEmail)throw Object.assign(new Error("A lead must keep a phone number or email address."),{statusCode:400});
      if(input.sourceId){const source=await client.query("SELECT 1 FROM lead_sources WHERE id=$1 AND is_active=TRUE",[input.sourceId]);if(!source.rows[0])throw Object.assign(new Error("Select an active lead source."),{statusCode:400});}
      if (input.assignedUserId) {
        const owner = await client.query("SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE",[input.assignedUserId]);
        if (!owner.rows[0]) throw Object.assign(new Error("Assigned employee is not active."),{statusCode:400});
      }
      const resultingStatus=has(input,"status")?input.status:current.status;const resultingLostReason=has(input,"lostReasonId")?input.lostReasonId:current.lost_reason_id;
      if(resultingStatus==="Lost"&&!resultingLostReason)throw Object.assign(new Error("A Lost lead must keep a lost reason."),{statusCode:400});
      if(input.lostReasonId){const reason=await client.query("SELECT 1 FROM lost_reasons WHERE id=$1 AND is_active=TRUE",[input.lostReasonId]);if(!reason.rows[0])throw Object.assign(new Error("Select an active lost reason."),{statusCode:400});}

      const columns:Record<string,string>={propertyType:"property_type",preferredLocation:"preferred_location",bedrooms:"bedrooms",budgetMin:"budget_min",budgetMax:"budget_max",furnishedPreference:"furnished_preference",moveInDate:"move_in_date",name:"name",phone:"phone",email:"email",sourceId:"source_id",interest:"interest",budget:"budget",notes:"notes",assignedUserId:"assigned_user_id",status:"status",priority:"priority",nextFollowUpAt:"next_follow_up_at",wonAmount:"won_amount",closingNote:"closing_note",lostReasonId:"lost_reason_id",lostNote:"lost_note"};
      const values:unknown[]=[]; const sets:string[]=[]; const changes:{field:string;oldValue:unknown;newValue:unknown}[]=[];
      for (const [key,column] of Object.entries(columns)) if (has(input,key)) {
        const value=(input as Record<string,unknown>)[key];
        if (key==="phone") { sets.push(`normalized_phone=$${values.push(normalizePhone(value)||null)}`); }
        if (key==="email") { sets.push(`normalized_email=$${values.push(normalizeEmail(value)||null)}`); }
        sets.push(`${column}=$${values.push(value ?? null)}`); changes.push({field:column,oldValue:current[column],newValue:value??null});
      }
      if (input.status==="Won") { sets.push("won_at=NOW()","lost_at=NULL","lost_reason_id=NULL","lost_note=NULL","next_follow_up_at=NULL"); }
      else if (input.status==="Lost") { sets.push("lost_at=NOW()","won_at=NULL","won_amount=NULL","closing_note=NULL","next_follow_up_at=NULL"); }
      else if (input.status && !["Won","Lost"].includes(input.status)) { sets.push("won_at=NULL","lost_at=NULL","lost_reason_id=NULL"); }
      if(input.status&&input.status!==current.status || has(input,'notes')&&input.notes!==current.notes) sets.push('last_interaction_at=NOW()');
      if(has(input,'notes')&&input.notes!==current.notes&&input.notes) await client.query('INSERT INTO lead_notes(lead_id,user_id,note) VALUES($1,$2,$3)',[leadId,request.auth!.user.id,input.notes]);
      if(has(input,'assignedUserId')&&input.assignedUserId!==current.assigned_user_id) await notifyAssignment(client,request.auth!.user,leadId,input.assignedUserId);
      if (!sets.length) return current;
      values.push(leadId);
      const result = await client.query<Record<string,unknown>>(`UPDATE leads SET ${sets.join(",")},version=version+1,updated_at=NOW() WHERE id=$${values.length} RETURNING *`,values);
      if (input.status && input.status!==current.status) await client.query("INSERT INTO lead_status_history (lead_id,old_status,new_status,changed_by) VALUES ($1,$2,$3,$4)",[leadId,current.status,input.status,request.auth!.user.id]);
      for (const change of changes) await writeAudit(client,{user:request.auth!.user,action:change.field==="assigned_user_id"?"Lead reassigned":change.field==="status"&&change.newValue==="Won"?"Lead marked Won":change.field==="status"&&change.newValue==="Lost"?"Lead marked Lost":change.field==="status"?"Status changed":change.field==="next_follow_up_at"?"Follow-up changed":"Lead edited",entityType:"lead",entityId:leadId,fieldChanged:change.field,oldValue:change.oldValue,newValue:change.newValue,ipAddress:ip(request)});
      return result.rows[0];
    });
    response.json({ id:leadId,version:Number(updated.version) });
  }));

  app.post("/api/leads/:id/notes", csrfMiddleware, asyncHandler(async (request,response)=>{
    const leadId=Number(request.params.id); await requireLeadAccess(db,request.auth!.user,leadId); const input=noteSchema.parse(request.body);
    const result=await withTransaction(db,async(client)=>{
      const lead=await client.query<{version:number}>("SELECT version FROM leads WHERE id=$1 AND is_deleted=FALSE FOR UPDATE",[leadId]);
      if(!lead.rows[0]) throw Object.assign(new Error("Lead not found."),{statusCode:404});
      await client.query("INSERT INTO lead_notes (lead_id,user_id,note) VALUES ($1,$2,$3)",[leadId,request.auth!.user.id,input.note]);
      const updated=await client.query<{version:number}>("UPDATE leads SET last_interaction_at=NOW(),updated_at=NOW(),version=version+1 WHERE id=$1 RETURNING version",[leadId]);
      await writeAudit(client,{user:request.auth!.user,action:"Note added",entityType:"lead",entityId:leadId,newValue:input.note,ipAddress:ip(request)}); return updated.rows[0];
    }); response.status(201).json(result);
  }));

  app.post("/api/leads/:id/interactions", csrfMiddleware, asyncHandler(async(request,response)=>{
    const leadId=Number(request.params.id); await requireLeadAccess(db,request.auth!.user,leadId); const input=interactionSchema.parse(request.body);
    if(input.type==='call'&&!input.outcome)throw fail('Choose a call outcome.',400);
    if(input.type!=='call'&&input.outcome)throw fail('Call outcomes are for calls only.',400);
    await withTransaction(db,async(client)=>{
      const lead=await client.query("SELECT 1 FROM leads WHERE id=$1 AND is_deleted=FALSE FOR UPDATE",[leadId]); if(!lead.rows[0]) throw Object.assign(new Error("Lead not found."),{statusCode:404});
      await client.query("INSERT INTO lead_interactions (lead_id,user_id,type,summary,outcome) VALUES ($1,$2,$3,$4,$5)",[leadId,request.auth!.user.id,input.type,input.summary,input.outcome??null]);
      await client.query("UPDATE leads SET last_interaction_at=NOW(),updated_at=NOW(),version=version+1 WHERE id=$1",[leadId]);
      await writeAudit(client,{user:request.auth!.user,action:`${input.type} recorded`,entityType:"lead",entityId:leadId,newValue:input.summary,ipAddress:ip(request)});
    }); response.status(201).json({ok:true});
  }));

  app.post("/api/tasks", csrfMiddleware, asyncHandler(async(request,response)=>{
    const input=taskCreateSchema.parse(request.body);
    if(input.leadId)await requireLeadAccess(db,request.auth!.user,input.leadId);
    if(leadScope(request.auth!.user)&&input.assignedUserId!==request.auth!.user.id)throw fail('You can create tasks only for yourself.');
    const result=await withTransaction(db,async(client)=>{
      const employee=await client.query("SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE",[input.assignedUserId]); if(!employee.rows[0]) throw Object.assign(new Error("Assigned employee is not active."),{statusCode:400});
      if(input.leadId){const lead=await client.query("SELECT 1 FROM leads WHERE id=$1 AND is_deleted=FALSE",[input.leadId]);if(!lead.rows[0])throw Object.assign(new Error("Related lead was not found."),{statusCode:400});}
      const task=await client.query<{id:number;version:number}>("INSERT INTO tasks (title,lead_id,due_at,assigned_user_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,version",[input.title,input.leadId,input.dueAt,input.assignedUserId,input.notes,request.auth!.user.id]);
      await writeAudit(client,{user:request.auth!.user,action:"Task created",entityType:"task",entityId:task.rows[0].id,newValue:input,ipAddress:ip(request)}); return task.rows[0];
    }); response.status(201).json(result);
  }));

  app.patch("/api/tasks/:id", csrfMiddleware, asyncHandler(async(request,response)=>{
    const taskId=Number(request.params.id); const input=taskPatchSchema.parse(request.body);
    const taskRecord=(await db.query<Record<string,unknown>>('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
    if(!taskRecord)throw fail('Task not found.',404);
    if(leadScope(request.auth!.user)){
      if(taskRecord.assigned_user_id!==request.auth!.user.id)throw fail('Task not found.',404);
      if(taskRecord.lead_id)await requireLeadAccess(db,request.auth!.user,Number(taskRecord.lead_id));
      if(input.assignedUserId&&input.assignedUserId!==request.auth!.user.id)throw fail('You can assign tasks only to yourself.');
    }
    const result=await withTransaction(db,async(client)=>{
      const currentResult=await client.query<Record<string,unknown>>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE",[taskId]); const current=currentResult.rows[0];
      if(!current) throw Object.assign(new Error("Task not found."),{statusCode:404}); if(Number(current.version)!==input.version) throw Object.assign(new Error("This task was changed by another user. Refresh and retry."),{statusCode:409});
      if(input.assignedUserId){const employee=await client.query("SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE",[input.assignedUserId]);if(!employee.rows[0])throw Object.assign(new Error("Assigned employee is not active."),{statusCode:400});}
      const map:Record<string,string>={title:"title",dueAt:"due_at",assignedUserId:"assigned_user_id",notes:"notes",isCompleted:"is_completed"}; const values:unknown[]=[];const sets:string[]=[];
      for(const[key,column]of Object.entries(map))if(has(input,key)){sets.push(`${column}=$${values.push((input as Record<string,unknown>)[key])}`);}
      if(has(input,"isCompleted"))sets.push(input.isCompleted?"completed_at=NOW()":"completed_at=NULL"); values.push(taskId);
      const updated=await client.query<{version:number}>(`UPDATE tasks SET ${sets.join(",")},version=version+1,updated_at=NOW() WHERE id=$${values.length} RETURNING version`,values);
      await writeAudit(client,{user:request.auth!.user,action:input.isCompleted===true?"Task completed":input.isCompleted===false?"Task reopened":"Task edited",entityType:"task",entityId:taskId,oldValue:current,newValue:input,ipAddress:ip(request)}); return updated.rows[0];
    }); response.json(result);
  }));

  app.post("/api/calendar-events",csrfMiddleware,asyncHandler(async(request,response)=>{
    const input=calendarEventCreateSchema.parse(request.body);
    await requireLeadAccess(db,request.auth!.user,input.leadId);
    if(leadScope(request.auth!.user)&&input.assignedUserId!==request.auth!.user.id)throw fail('You can schedule appointments only for yourself.');
    const result=await withTransaction(db,async(client)=>{
      const lead=await client.query("SELECT 1 FROM leads WHERE id=$1 AND is_deleted=FALSE FOR UPDATE",[input.leadId]);if(!lead.rows[0])throw Object.assign(new Error("Lead not found."),{statusCode:404});
      const employee=await client.query("SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE",[input.assignedUserId]);if(!employee.rows[0])throw Object.assign(new Error("Assigned employee is not active."),{statusCode:400});
      const event=await client.query<{id:number}>("INSERT INTO calendar_events (lead_id,title,event_type,starts_at,ends_at,assigned_user_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",[input.leadId,input.title,input.eventType,input.startsAt,input.endsAt,input.assignedUserId,request.auth!.user.id]);
      await client.query("UPDATE leads SET last_interaction_at=NOW(),updated_at=NOW(),version=version+1 WHERE id=$1",[input.leadId]);
      await writeAudit(client,{user:request.auth!.user,action:`${input.eventType==="viewing"?"Viewing":"Meeting"} scheduled`,entityType:"calendar_event",entityId:event.rows[0].id,newValue:input,ipAddress:ip(request)});return event.rows[0];
    });response.status(201).json(result);
  }));

  app.get("/api/employees", requireRole("Administrator","Manager","Reception"), asyncHandler(async(_request,response)=>response.json(await getEmployees(db,true))));
  app.post("/api/employees", csrfMiddleware, requireRole("Administrator","Manager","Reception"), asyncHandler(async(request,response)=>{
    const input=employeeCreateSchema.parse(request.body); const normalizedEmail=normalizeEmail(input.email); const hash=await bcrypt.hash(input.password,12); const id=randomUUID();
    if(request.auth!.user.role==="Reception"&&input.role==="Administrator")throw fail("Only management or administrators can create administrator accounts.");
    await withTransaction(db,async(client)=>{await client.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,phone,role,password_hash,account_role,own_leads_only) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,input.firstName,input.lastName,input.displayName,normalizedEmail,input.email,input.phone||null,input.role==="Reception"?"Sales Employee":input.role,hash,input.role,input.ownLeadsOnly]);await writeAudit(client,{user:request.auth!.user,action:"Employee added",entityType:"user",entityId:id,newValue:{displayName:input.displayName,email:input.email,role:input.role},ipAddress:ip(request)});});
    response.status(201).json({id});
  }));

  app.patch("/api/employees/:id", csrfMiddleware, requireRole("Administrator","Manager","Reception"), asyncHandler(async(request,response)=>{
    const employeeId=String(request.params.id); const input=employeePatchSchema.parse(request.body);
    const passwordHash=input.password?await bcrypt.hash(input.password,12):undefined;
    const result=await withTransaction(db,async(client)=>{const currentResult=await client.query<Record<string,unknown>>("SELECT * FROM users WHERE id=$1 FOR UPDATE",[employeeId]);const current=currentResult.rows[0];if(!current)throw Object.assign(new Error("Employee not found."),{statusCode:404});if(Number(current.version)!==input.version)throw Object.assign(new Error("This employee was changed by another user."),{statusCode:409});
      if(request.auth!.user.role==="Reception"&&((current.account_role??current.role)!=="Sales Employee"||(input.role&&input.role!=="Sales Employee")))throw fail("Reception may edit sales employees only.");
      if(input.isActive===false&&employeeId===request.auth!.user.id)throw fail('You cannot deactivate your own account.',400);
      if(input.role==='Administrator'&&current.role!=='Administrator') {const owned=await client.query<{count:number}>('SELECT COUNT(*) AS count FROM leads WHERE assigned_user_id=$1 AND is_deleted=0',[employeeId]);if(owned.rows[0].count>0)throw fail('Reassign this employee’s leads before making them an administrator.',409);}
      if(current.role==="Administrator"&&((input.role&&input.role!=="Administrator")||input.isActive===false)){const admins=await client.query<{count:number}>("SELECT COUNT(*)::int AS count FROM users WHERE role='Administrator' AND is_active=TRUE",[]);if((admins.rows[0]?.count??0)<=1)throw Object.assign(new Error("The final active administrator cannot be demoted or deactivated."),{statusCode:409});}
      if(input.isActive===false){const count=await client.query<{count:number}>("SELECT COUNT(*)::int AS count FROM leads WHERE assigned_user_id=$1 AND status<>'Won' AND status<>'Lost' AND is_deleted=FALSE",[employeeId]);if((count.rows[0]?.count??0)>0)throw Object.assign(new Error("Transfer active leads before deactivating this employee."),{statusCode:409,activeLeads:count.rows[0].count});}
      const map:Record<string,string>={ownLeadsOnly:"own_leads_only",firstName:"first_name",lastName:"last_name",displayName:"display_name",email:"email",phone:"phone",role:"role",isActive:"is_active"};const values:unknown[]=[];const sets:string[]=[];for(const[key,column]of Object.entries(map))if(has(input,key)){const value=(input as Record<string,unknown>)[key];sets.push(`${column}=$${values.push(key==="role"&&value==="Reception"?"Sales Employee":value??null)}`);if(key==="role")sets.push(`account_role=$${values.push(value)}`);if(key==="email")sets.push(`normalized_email=$${values.push(normalizeEmail(value))}`);}if(passwordHash){sets.push(`password_hash=$${values.push(passwordHash)}`);await client.query("DELETE FROM sessions WHERE user_id=$1",[employeeId]);}values.push(employeeId);const updated=await client.query<{version:number}>(`UPDATE users SET ${sets.join(",")},version=version+1,updated_at=NOW() WHERE id=$${values.length} RETURNING version`,values);await writeAudit(client,{user:request.auth!.user,action:"Employee edited",entityType:"user",entityId:employeeId,oldValue:current,newValue:input,ipAddress:ip(request)});return updated.rows[0];});response.json(result);
  }));

  app.post("/api/employees/:id/deactivate", csrfMiddleware, requireRole("Administrator","Manager","Reception"), asyncHandler(async(request,response)=>{
    const employeeId=String(request.params.id); const input=deactivateEmployeeSchema.parse(request.body);
    if(employeeId===request.auth!.user.id)return response.status(400).json({error:"You cannot deactivate your own account."});
    const result=await withTransaction(db,async(client)=>{const employee=await client.query<{display_name:string;is_active:boolean;role:string}>("SELECT display_name,is_active,COALESCE(account_role,role) AS role FROM users WHERE id=$1 FOR UPDATE",[employeeId]);if(!employee.rows[0])throw Object.assign(new Error("Employee not found."),{statusCode:404});if(request.auth!.user.role==="Reception"&&employee.rows[0].role!=="Sales Employee")throw fail("Reception may deactivate sales employees only.");if(employee.rows[0].role==="Administrator"){const admins=await client.query<{count:number}>("SELECT COUNT(*)::int AS count FROM users WHERE role='Administrator' AND is_active=TRUE",[]);if((admins.rows[0]?.count??0)<=1)throw Object.assign(new Error("The final active administrator cannot be deactivated."),{statusCode:409});}const owned=await client.query<{count:number}>("SELECT COUNT(*)::int AS count FROM leads WHERE assigned_user_id=$1 AND status<>'Won' AND status<>'Lost' AND is_deleted=FALSE",[employeeId]);const count=owned.rows[0]?.count??0;
      if(count>0&&!input.transferToUserId)throw Object.assign(new Error(`This employee currently owns ${count} active leads. Choose another employee to receive them.`),{statusCode:409,activeLeads:count});
      if(input.transferToUserId){await validateAssignment(client,request.auth!.user,input.transferToUserId);if(input.transferToUserId===employeeId)throw Object.assign(new Error("Choose a different employee for transfer."),{statusCode:400});const target=await client.query<{display_name:string}>("SELECT display_name FROM users WHERE id=$1 AND is_active=TRUE",[input.transferToUserId]);if(!target.rows[0])throw Object.assign(new Error("Transfer employee is not active."),{statusCode:400});const transferredLeads=await client.query<{id:number}>("SELECT id FROM leads WHERE assigned_user_id=$1 AND status<>'Won' AND status<>'Lost' AND is_deleted=FALSE FOR UPDATE",[employeeId]);await client.query("UPDATE leads SET assigned_user_id=$1,version=version+1,updated_at=NOW() WHERE assigned_user_id=$2 AND status<>'Won' AND status<>'Lost' AND is_deleted=FALSE",[input.transferToUserId,employeeId]);for(const lead of transferredLeads.rows)await notifyAssignment(client,request.auth!.user,lead.id,input.transferToUserId);for(const lead of transferredLeads.rows)await writeAudit(client,{user:request.auth!.user,action:"Lead reassigned",entityType:"lead",entityId:lead.id,fieldChanged:"assigned_user_id",oldValue:employeeId,newValue:input.transferToUserId,metadata:{reason:"Employee deactivation transfer"},ipAddress:ip(request)});await writeAudit(client,{user:request.auth!.user,action:"Active leads transferred",entityType:"user",entityId:employeeId,oldValue:employee.rows[0].display_name,newValue:target.rows[0].display_name,metadata:{leadCount:count},ipAddress:ip(request)});}
      await client.query("UPDATE users SET is_active=FALSE,version=version+1,updated_at=NOW() WHERE id=$1",[employeeId]);await client.query("DELETE FROM sessions WHERE user_id=$1",[employeeId]);await writeAudit(client,{user:request.auth!.user,action:"Employee deactivated",entityType:"user",entityId:employeeId,oldValue:true,newValue:false,ipAddress:ip(request)});return{transferred:count,deactivated:true};});response.json(result);
  }));

  app.patch("/api/settings", csrfMiddleware, requireRole("Administrator","Manager"), asyncHandler(async(request,response)=>{
    const input=settingsSchema.parse(request.body); await withTransaction(db,async(client)=>{for(const[key,value]of Object.entries(input)){const old=await client.query<{value:unknown}>("SELECT value FROM settings WHERE key=$1 FOR UPDATE",[key]);await client.query("INSERT INTO settings (key,value,updated_by,updated_at) VALUES ($1,$2::jsonb,$3,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()",[key,JSON.stringify(value),request.auth!.user.id]);await writeAudit(client,{user:request.auth!.user,action:"Settings changed",entityType:"setting",entityId:key,oldValue:old.rows[0]?.value,newValue:value,ipAddress:ip(request)});}});response.json(await getSettings(db));
  }));

  app.post("/api/options/:type", csrfMiddleware, requireRole("Administrator","Manager"), asyncHandler(async(request,response)=>{
    const type=String(request.params.type);const table=type==="sources"?"lead_sources":type==="lost-reasons"?"lost_reasons":"";if(!table)return response.status(404).json({error:"Option type not found."});const name=typeof request.body?.name==="string"?request.body.name.trim():"";if(name.length<2||name.length>100)return response.status(400).json({error:"Enter a name between 2 and 100 characters."});
    const result=await withTransaction(db,async(client)=>{const inserted=await client.query<{id:number}>(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id`,[name]);await writeAudit(client,{user:request.auth!.user,action:type==="sources"?"Lead source added":"Lost reason added",entityType:type,entityId:inserted.rows[0].id,newValue:name,ipAddress:ip(request)});return inserted.rows[0];});response.status(201).json(result);
  }));

  app.patch("/api/options/:type/:id", csrfMiddleware, requireRole("Administrator","Manager"), asyncHandler(async(request,response)=>{
    const type=String(request.params.type);const table=type==="sources"?"lead_sources":type==="lost-reasons"?"lost_reasons":"";if(!table)return response.status(404).json({error:"Option type not found."});const optionId=Number(request.params.id);const hasName=typeof request.body?.name==="string";const hasActive=typeof request.body?.isActive==="boolean";if(!hasName&&!hasActive)return response.status(400).json({error:"No option changes were supplied."});const name=hasName?request.body.name.trim():null;if(hasName&&(name.length<2||name.length>100))return response.status(400).json({error:"Enter a name between 2 and 100 characters."});
    const result=await withTransaction(db,async(client)=>{const current=await client.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[optionId]);if(!current.rows[0])throw Object.assign(new Error("Option not found."),{statusCode:404});const values:unknown[]=[];const sets:string[]=[];if(hasName)sets.push(`name=$${values.push(name)}`);if(hasActive)sets.push(`is_active=$${values.push(request.body.isActive)}`);sets.push("updated_at=NOW()");values.push(optionId);await client.query(`UPDATE ${table} SET ${sets.join(",")} WHERE id=$${values.length}`,values);await writeAudit(client,{user:request.auth!.user,action:type==="sources"?"Lead source changed":"Lost reason changed",entityType:type,entityId:optionId,oldValue:current.rows[0],newValue:request.body,ipAddress:ip(request)});return{ok:true};});response.json(result);
  }));

  app.get("/api/audit", requireRole("Administrator","Manager"), asyncHandler(async(request,response)=>{
    const values:unknown[]=[];const where:string[]=[];const add=(value:unknown)=>{values.push(value);return `$${values.length}`};
    if(typeof request.query.userId==="string"&&request.query.userId)where.push(`user_id=${add(request.query.userId)}`);
    if(typeof request.query.leadId==="string"&&/^\d+$/.test(request.query.leadId))where.push(`entity_type='lead' AND entity_id=${add(request.query.leadId)}`);
    if(typeof request.query.action==="string"&&request.query.action.trim())where.push(`action ILIKE ${add(`%${request.query.action.trim()}%`)}`);
    if(typeof request.query.from==="string"&&!Number.isNaN(Date.parse(request.query.from)))where.push(`timestamp>=${add(new Date(request.query.from).toISOString())}`);
    if(typeof request.query.to==="string"&&!Number.isNaN(Date.parse(request.query.to)))where.push(`timestamp<${add(new Date(request.query.to).toISOString())}`);
    const limit=Math.min(500,Math.max(1,Number(request.query.limit)||100));values.push(limit);const result=await db.query(`SELECT * FROM audit_logs ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY timestamp DESC LIMIT $${values.length}`,values);response.json(result.rows);
  }));
  app.get("/api/dashboard", asyncHandler(async(request,response)=>response.json(await getDashboard(db,leadScope(request.auth!.user)))));
  app.get("/api/reports", requireRole("Administrator","Manager"), asyncHandler(async(_request,response)=>response.json(await getReports(db))));

  app.get('/api/export/leads.csv',requireRole('Administrator','Manager'),asyncHandler(async(req,res)=>{
    const q=req.query;const text=(key:string)=>typeof q[key]==='string'?q[key] as string:undefined;
    const filters={query:text('q'),ownerId:text('ownerId'),sourceId:Number(text('sourceId'))||undefined,status:text('status'),priority:text('priority'),attention:text('attention'),limit:200};
    const rows:unknown[][]=[];let page=1,total=0;
    do {const result=await getLeadList(db,{...filters,page});total=result.total;
      for(const l of result.items)rows.push([l.reference,l.name,l.phone,l.email,l.source,l.interest,l.status,l.owner,l.priority,l.followUp,l.propertyType,l.preferredLocation,l.bedrooms,l.budgetMin,l.budgetMax,l.furnishedPreference,l.moveInDate,l.lostReason,l.createdAt]);
      page++;
    } while(rows.length<total);
    const headers=['Reference','Name','Phone','Email','Source','Interest','Status','Assigned to','Priority','Next follow-up','Property type','Preferred location','Bedrooms','Minimum budget','Maximum budget','Furnished preference','Move-in date','Lost reason','Created'];
    res.setHeader('content-type','text/csv; charset=utf-8');res.setHeader('content-disposition','attachment; filename="lead-filtered-leads.csv"');res.send('\uFEFF'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n'));
  }));
  app.get("/api/export/audit.csv", requireRole("Administrator","Manager"), asyncHandler(async(_request,response)=>{
    const result=await db.query<Record<string,unknown>>("SELECT timestamp,user_name,action,entity_type,entity_id,field_changed,old_value,new_value,ip_address FROM audit_logs ORDER BY timestamp DESC");const headers=["Timestamp","User","Action","Entity Type","Entity ID","Field","Old Value","New Value","IP Address"];const keys=["timestamp","user_name","action","entity_type","entity_id","field_changed","old_value","new_value","ip_address"];const rows=result.rows.map((row)=>keys.map((key)=>csvCell(row[key])).join(","));response.setHeader("content-type","text/csv; charset=utf-8");response.setHeader("content-disposition",`attachment; filename="lead-audit-${new Date().toISOString().slice(0,10)}.csv"`);response.send(`\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`);
  }));

  app.get("/api/export/tasks.csv",requireRole("Administrator","Manager"),asyncHandler(async(_request,response)=>{const result=await db.query<Record<string,unknown>>(`SELECT t.id,t.title,l.name AS lead,t.due_at,u.display_name AS assigned_to,t.is_completed,t.created_at,t.completed_at,creator.display_name AS created_by FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id JOIN users u ON u.id=t.assigned_user_id JOIN users creator ON creator.id=t.created_by ORDER BY t.created_at DESC`);const headers=["ID","Task","Lead","Due","Assigned To","Completed","Created","Completed At","Created By"];const keys=["id","title","lead","due_at","assigned_to","is_completed","created_at","completed_at","created_by"];const rows=result.rows.map(row=>keys.map(key=>csvCell(row[key])).join(","));response.setHeader("content-type","text/csv; charset=utf-8");response.setHeader("content-disposition",`attachment; filename="lead-tasks-${new Date().toISOString().slice(0,10)}.csv"`);response.send(`\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`);}));

  app.get("/api/export/employee-performance.csv",requireRole("Administrator","Manager"),asyncHandler(async(_request,response)=>{const report=await getReports(db);const headers=["Employee","Assigned","Contacted","Active","Overdue","Won","Lost","Conversion Rate"];const rows=report.employees.map((item)=>{const row=item as Record<string,unknown>&{conversionRate:number};return[row.display_name,row.assigned,row.contacted,row.active,row.overdue,row.won,row.lost,`${row.conversionRate}%`].map(csvCell).join(",")});response.setHeader("content-type","text/csv; charset=utf-8");response.setHeader("content-disposition",`attachment; filename="lead-employee-performance-${new Date().toISOString().slice(0,10)}.csv"`);response.send(`\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`);}));

  app.get("/api/export/lead-sources.csv",requireRole("Administrator","Manager"),asyncHandler(async(_request,response)=>{const report=await getReports(db);const headers=["Lead Source","Lead Count"];const rows=report.sources.map((row)=>[row.name,row.count].map(csvCell).join(","));response.setHeader("content-type","text/csv; charset=utf-8");response.setHeader("content-disposition",`attachment; filename="lead-lead-sources-${new Date().toISOString().slice(0,10)}.csv"`);response.send(`\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`);}));

  app.get("/api/export/closed-leads.csv",requireRole("Administrator","Manager"),asyncHandler(async(_request,response)=>{const result=await db.query<Record<string,unknown>>(`SELECT l.id,l.name,l.status,u.display_name AS assigned_to,l.interest,l.won_amount,l.won_at,r.name AS lost_reason,l.lost_at FROM leads l LEFT JOIN users u ON u.id=l.assigned_user_id LEFT JOIN lost_reasons r ON r.id=l.lost_reason_id WHERE l.is_deleted=FALSE AND (l.status='Won' OR l.status='Lost') ORDER BY COALESCE(l.won_at,l.lost_at) DESC`);const headers=["Reference","Lead","Status","Assigned To","Interest","Deal Amount","Won At","Lost Reason","Lost At"];const rows=result.rows.map(row=>[`LEAD-${String(row.id).padStart(6,"0")}`,row.name,row.status,row.assigned_to,row.interest,row.won_amount,row.won_at,row.lost_reason,row.lost_at].map(csvCell).join(","));response.setHeader("content-type","text/csv; charset=utf-8");response.setHeader("content-disposition",`attachment; filename="lead-closed-leads-${new Date().toISOString().slice(0,10)}.csv"`);response.send(`\uFEFF${headers.map(csvCell).join(",")}\r\n${rows.join("\r\n")}`);}));

  app.use("/api", (_request,response)=>response.status(404).json({error:"API endpoint not found."}));
  app.use((error:unknown, request:Request, response:Response, _next:NextFunction)=>{
    void _next;
    request.log?.error({err:error},"Request failed");
    if(error instanceof ZodError)return response.status(400).json({error:"Some information is invalid.",details:error.issues.map((issue)=>({field:issue.path.join("."),message:issue.message}))});
    if(error instanceof Error && error.message.includes('UNIQUE constraint failed: users.normalized_email'))return response.status(409).json({error:'An account already exists with that email address.'});
    const typed=error as {statusCode?:number;message?:string;code?:string;activeLeads?:number};const status=typed.statusCode&&typed.statusCode>=400&&typed.statusCode<600?typed.statusCode:500;const message=status===500?"Unable to complete the request. Please retry.":typed.message??"Request failed.";response.status(status).json({error:message,code:typed.code,activeLeads:typed.activeLeads});
  });
  return app;
}
