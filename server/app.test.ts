import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { normalizeEmail } from "./domain.js";
import { runMigrations } from "./migrate.js";

const testLogLevel=(process.env.TEST_LOG_LEVEL??"silent") as AppConfig["LOG_LEVEL"];
const config:AppConfig={NODE_ENV:"test",DATABASE_FILE:":memory:",APP_PORT:3000,FRONTEND_PORT:3001,SESSION_HOURS:12,LOG_LEVEL:testLogLevel,TRUST_PROXY:"false",COOKIE_SECURE:"false"};

async function fixture(){
  const pool=createDatabase(":memory:");
  await runMigrations(pool);
  const adminId=randomUUID();const employeeId=randomUUID();const managerId=randomUUID();
  const hash=await bcrypt.hash("SecurePassword!2026",4);
  await pool.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,role,password_hash) VALUES ($1,'Demo','Admin','Demo Admin',$2,$2,'Administrator',$3)",[adminId,normalizeEmail("admin@example.test"),hash]);
  await pool.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,role,password_hash) VALUES ($1,'Sarah','Sales','Sarah Sales',$2,$2,'Sales Employee',$3)",[employeeId,normalizeEmail("sarah@example.test"),hash]);
  await pool.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,role,password_hash) VALUES ($1,'Mona','Manager','Mona Manager',$2,$2,'Manager',$3)",[managerId,normalizeEmail("manager@example.test"),hash]);
  return{pool,adminId,employeeId,managerId,app:createApp(pool,config)};
}

test("LAN production headers do not force HTTP clients onto unavailable HTTPS",async()=>{
  const{pool}=await fixture();
  const lanConfig:AppConfig={...config,NODE_ENV:"production",COOKIE_SECURE:"false"};
  const response=await request(createApp(pool,lanConfig)).get("/api/health").expect(200);
  assert.equal(response.headers["strict-transport-security"],undefined);
  assert.equal(String(response.headers["content-security-policy"]??"").includes("upgrade-insecure-requests"),false);
});

test("authenticated lead lifecycle persists and writes audit history",async()=>{
  const{pool,employeeId,app}=await fixture();const agent=request.agent(app);
  const login=await agent.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const csrf=login.body.csrfToken as string;
  const source=await pool.query<{id:number}>("SELECT id FROM lead_sources WHERE name='Instagram'");
  const created=await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Ahmed",phone:"+971 50 123 4567",sourceId:source.rows[0].id,interest:"2 bedroom apartment",assignedUserId:employeeId,priority:"High",nextFollowUpAt:new Date(Date.now()+86400000).toISOString()}).expect(201);
  const leadId=created.body.id as number;
  await agent.post(`/api/leads/${leadId}/notes`).set("x-csrf-token",csrf).send({note:"Customer requested a Saturday viewing."}).expect(201);
  const noteSearch=await agent.get("/api/leads?q=Saturday%20viewing").expect(200);assert.equal(noteSearch.body.items.some((item:{id:number})=>item.id===leadId),true);
  const bootstrap=await agent.get("/api/bootstrap").expect(200);const lead=bootstrap.body.leads.items.find((item:{id:number})=>item.id===leadId);assert.equal(lead.owner,"Sarah Sales");assert.equal(lead.timeline.some((item:{type:string})=>item.type==="note"),true,JSON.stringify(lead.timeline));
  await agent.patch(`/api/leads/${leadId}`).set("x-csrf-token",csrf).send({version:lead.version,status:"Qualified"}).expect(200);
  const task=await agent.post("/api/tasks").set("x-csrf-token",csrf).send({title:"Schedule viewing",leadId,dueAt:new Date(Date.now()+3600000).toISOString(),assignedUserId:employeeId}).expect(201);
  await agent.patch(`/api/tasks/${task.body.id}`).set("x-csrf-token",csrf).send({version:task.body.version,isCompleted:true}).expect(200);
  const completedLead=(await agent.get(`/api/leads?q=Ahmed`).expect(200)).body.items.find((item:{id:number})=>item.id===leadId);assert.equal(completedLead.timeline.some((item:{title:string})=>item.title==="Task created"),true);assert.equal(completedLead.timeline.some((item:{title:string})=>item.title==="Task completed"),true);
  const audit=await agent.get("/api/audit").expect(200);assert.equal(audit.body.some((item:{action:string})=>item.action==="Status changed"),true);assert.equal(audit.body.some((item:{action:string})=>item.action==="Task completed"),true);
  await agent.post("/api/auth/logout").set("x-csrf-token",csrf).expect(204);await agent.get("/api/bootstrap").expect(401);
});

test("duplicate detection treats local and international UAE phone formats as equivalent",async()=>{
  const{pool,app}=await fixture();const agent=request.agent(app);const login=await agent.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"});const csrf=login.body.csrfToken;const source=await pool.query<{id:number}>("SELECT id FROM lead_sources WHERE name='Instagram'");
  await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Ahmed",phone:"+971501234567",sourceId:source.rows[0].id,interest:"Apartment"}).expect(201);
  const duplicate=await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Ahmed Test",phone:"0501234567",sourceId:source.rows[0].id,interest:"Apartment"}).expect(409);assert.equal(duplicate.body.duplicate.name,"Ahmed");
});

test("employee deactivation requires transfer and preserves lead ownership",async()=>{
  const{pool,employeeId,app}=await fixture();const agent=request.agent(app);const login=await agent.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"});const csrf=login.body.csrfToken;const source=await pool.query<{id:number}>("SELECT id FROM lead_sources LIMIT 1");
  await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Owned lead",phone:"0509998888",sourceId:source.rows[0].id,interest:"Villa",assignedUserId:employeeId}).expect(201);
  const blocked=await agent.post(`/api/employees/${employeeId}/deactivate`).set("x-csrf-token",csrf).send({}).expect(409);assert.equal(blocked.body.activeLeads,1);
  const target=randomUUID();const hash=await bcrypt.hash("SecurePassword!2026",4);await pool.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,role,password_hash) VALUES ($1,'Taylor','Sales','Taylor Sales',$2,$2,'Sales Employee',$3)",[target,"taylor@example.test",hash]);
  await agent.post(`/api/employees/${employeeId}/deactivate`).set("x-csrf-token",csrf).send({transferToUserId:target}).expect(200);const owner=await pool.query<{assigned_user_id:string}>("SELECT assigned_user_id FROM leads WHERE name='Owned lead'");assert.equal(owner.rows[0].assigned_user_id,target);
  const transferred=(await agent.get("/api/leads?q=Owned%20lead").expect(200)).body.items[0];assert.equal(transferred.timeline.some((item:{title:string;detail:string})=>item.title==="Assignment changed"&&item.detail==="Sarah Sales → Taylor Sales"),true,JSON.stringify(transferred.timeline));
});

test("server search, combined filters, overdue detection and settings persist",async()=>{
  const{pool,employeeId,app}=await fixture();const agent=request.agent(app);const login=await agent.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const csrf=login.body.csrfToken;const source=await pool.query<{id:number}>("SELECT id FROM lead_sources WHERE name='Instagram'");
  const past=new Date(Date.now()-3600000).toISOString();
  const created=await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Fatima Searchable",phone:"050 555 1122",email:"fatima@example.test",sourceId:source.rows[0].id,interest:"Palm villa",notes:"Needs mortgage documents",assignedUserId:employeeId,priority:"Urgent",nextFollowUpAt:past}).expect(201);
  const filtered=await agent.get(`/api/leads?q=05551122&ownerId=${employeeId}&sourceId=${source.rows[0].id}&status=New&priority=Urgent&attention=overdue`).expect(200);assert.equal(filtered.body.total,1);assert.equal(filtered.body.items[0].id,created.body.id);
  const neglected=await agent.get("/api/leads?attention=neglected").expect(200);assert.equal(neglected.body.items.some((item:{id:number})=>item.id===created.body.id),true);
  await agent.patch("/api/settings").set("x-csrf-token",csrf).send({company:{companyName:"Example Company UAE",timezone:"Asia/Dubai",currency:"AED",internalUrl:"http://crm.test.local"},attentionRules:{newLeadHours:12,inactiveLeadHours:48,flagMissingFollowUp:true,flagUnassigned:true}}).expect(200);
  await agent.post("/api/options/sources").set("x-csrf-token",csrf).send({name:"Trade Show"}).expect(201);
  const bootstrap=await agent.get("/api/bootstrap").expect(200);assert.equal(bootstrap.body.settings.company.companyName,"Example Company UAE");assert.equal(bootstrap.body.settings.attentionRules.inactiveLeadHours,48);assert.equal(bootstrap.body.sources.some((item:{name:string})=>item.name==="Trade Show"),true);
});

test("won, lost and scheduled appointments persist and update reports",async()=>{
  const{pool,employeeId,app}=await fixture();const agent=request.agent(app);const login=await agent.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const csrf=login.body.csrfToken;const source=await pool.query<{id:number}>("SELECT id FROM lead_sources LIMIT 1");const reason=await pool.query<{id:number}>("SELECT id FROM lost_reasons WHERE name='Budget mismatch'");
  const won=await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Won Customer",phone:"0507000001",sourceId:source.rows[0].id,interest:"Downtown office",assignedUserId:employeeId,nextFollowUpAt:new Date(Date.now()+86400000).toISOString()}).expect(201);
  await agent.post("/api/calendar-events").set("x-csrf-token",csrf).send({title:"Office viewing",leadId:won.body.id,eventType:"viewing",startsAt:new Date(Date.now()+7200000).toISOString(),endsAt:new Date(Date.now()+10800000).toISOString(),assignedUserId:employeeId}).expect(201);
  const wonLead=(await agent.get("/api/leads").expect(200)).body.items.find((item:{id:number})=>item.id===won.body.id);await agent.patch(`/api/leads/${won.body.id}`).set("x-csrf-token",csrf).send({version:wonLead.version,status:"Won",wonAmount:1250000,closingNote:"Signed reservation agreement"}).expect(200);
  const lost=await agent.post("/api/leads").set("x-csrf-token",csrf).send({name:"Lost Customer",phone:"0507000002",sourceId:source.rows[0].id,interest:"Beach villa",assignedUserId:employeeId}).expect(201);await agent.patch(`/api/leads/${lost.body.id}`).set("x-csrf-token",csrf).send({version:lost.body.version,status:"Lost",lostReasonId:reason.rows[0].id,lostNote:"Budget did not match"}).expect(200);
  const bootstrap=await agent.get("/api/bootstrap").expect(200);const savedWon=bootstrap.body.leads.items.find((item:{id:number})=>item.id===won.body.id);const savedLost=bootstrap.body.leads.items.find((item:{id:number})=>item.id===lost.body.id);assert.equal(savedWon.status,"Won");assert.equal(savedWon.followUp,null);assert.equal(savedWon.wonAmount,1250000);assert.equal(savedLost.lostReason,"Budget mismatch");assert.equal(bootstrap.body.calendarEvents.some((item:{leadId:number;eventType:string})=>item.leadId===won.body.id&&item.eventType==="viewing"),true);assert.equal(bootstrap.body.dashboard.won,1);assert.equal(bootstrap.body.dashboard.lost,1);
});

test("employee accounts accept eight-character temporary passwords",async()=>{
  const{app}=await fixture();const admin=request.agent(app);
  const login=await admin.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const csrf=login.body.csrfToken;
  await admin.post("/api/employees").set("x-csrf-token",csrf).send({firstName:"Eight",lastName:"Chars",displayName:"Eight Chars",email:"eight@example.test",role:"Sales Employee",password:"Eight888"}).expect(201);
  await request(app).post("/api/auth/login").send({email:"eight@example.test",password:"Eight888"}).expect(200);
  await admin.post("/api/employees").set("x-csrf-token",csrf).send({firstName:"Too",lastName:"Short",displayName:"Too Short",email:"short@example.test",role:"Sales Employee",password:"Short77"}).expect(400);
});

test("authorization, CSRF and final-administrator safeguards are enforced",async()=>{
  const{pool,adminId,app}=await fixture();
  const sales=request.agent(app);const salesLogin=await sales.post("/api/auth/login").send({email:"sarah@example.test",password:"SecurePassword!2026"}).expect(200);await sales.get("/api/employees").expect(403);await sales.patch("/api/settings").set("x-csrf-token",salesLogin.body.csrfToken).send({company:{companyName:"Blocked",timezone:"UTC",currency:"AED",internalUrl:""}}).expect(403);
  const manager=request.agent(app);const managerLogin=await manager.post("/api/auth/login").send({email:"manager@example.test",password:"SecurePassword!2026"}).expect(200);const managerCsrf=managerLogin.body.csrfToken;await manager.post("/api/employees").set("x-csrf-token",managerCsrf).send({firstName:"New",lastName:"Admin",displayName:"New Admin",email:"newadmin@example.test",role:"Administrator",password:"SecurePassword!2026"}).expect(201);await pool.query("UPDATE users SET is_active=0 WHERE normalized_email='newadmin@example.test'");await manager.post("/api/employees").set("x-csrf-token",managerCsrf).send({firstName:"New",lastName:"Sales",displayName:"New Sales",email:"newsales@example.test",role:"Sales Employee",password:"SecurePassword!2026"}).expect(201);
  const admin=request.agent(app);const adminLogin=await admin.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);await admin.patch("/api/settings").send({attentionRules:{newLeadHours:24,inactiveLeadHours:72,flagMissingFollowUp:true,flagUnassigned:true}}).expect(403);const record=await pool.query<{version:number}>("SELECT version FROM users WHERE id=$1",[adminId]);await admin.patch(`/api/employees/${adminId}`).set("x-csrf-token",adminLogin.body.csrfToken).send({version:record.rows[0].version,role:"Manager"}).expect(409);
});

test("lead, note, task, assignment and follow-up survive an application restart",async()=>{
  const{pool,employeeId,app}=await fixture();const first=request.agent(app);const login=await first.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const csrf=login.body.csrfToken;const source=await pool.query<{id:number}>("SELECT id FROM lead_sources LIMIT 1");const followUp=new Date(Date.now()+172800000).toISOString();
  const created=await first.post("/api/leads").set("x-csrf-token",csrf).send({name:"Restart Persistent",phone:"0508112233",sourceId:source.rows[0].id,interest:"Warehouse",assignedUserId:employeeId,nextFollowUpAt:followUp}).expect(201);await first.post(`/api/leads/${created.body.id}/notes`).set("x-csrf-token",csrf).send({note:"Must remain after gateway restart"}).expect(201);await first.post("/api/tasks").set("x-csrf-token",csrf).send({title:"Send floor plan",leadId:created.body.id,dueAt:followUp,assignedUserId:employeeId}).expect(201);
  const restarted=createApp(pool,config);const second=request.agent(restarted);await second.post("/api/auth/login").send({email:"admin@example.test",password:"SecurePassword!2026"}).expect(200);const bootstrap=await second.get("/api/bootstrap").expect(200);const lead=bootstrap.body.leads.items.find((item:{id:number})=>item.id===created.body.id);assert.equal(lead.owner,"Sarah Sales");assert.equal(Math.abs(new Date(lead.followUp).getTime()-new Date(followUp).getTime())<1000,true);assert.equal(lead.timeline.some((item:{detail:string})=>item.detail==="Must remain after gateway restart"),true);assert.equal(bootstrap.body.tasks.some((item:{leadId:number;title:string})=>item.leadId===created.body.id&&item.title==="Send floor plan"),true);
});
