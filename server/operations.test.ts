import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {randomUUID} from 'node:crypto';
import {createDatabase} from './db.js';
import {runMigrations} from './migrate.js';
import {createApp} from './app.js';
import type {Role} from './domain.js';

async function setup(){
 const db=createDatabase(':memory:');await runMigrations(db);
 const app=createApp(db,{NODE_ENV:'test',DATABASE_FILE:':memory:',APP_PORT:3000,FRONTEND_PORT:3001,SESSION_HOURS:12,LOG_LEVEL:'silent',TRUST_PROXY:'false',COOKIE_SECURE:'false'});
 const users={} as Record<string,{id:string;agent:ReturnType<typeof request.agent>;csrf:string}>;
 for(const[name,role]of Object.entries({admin:'Administrator',manager:'Manager',reception:'Reception',sales:'Sales Employee',other:'Sales Employee'}) as [string,Role][]){const id=randomUUID();await db.query('INSERT INTO users(id,first_name,last_name,display_name,normalized_email,email,role,account_role,password_hash) VALUES($1,$2,$2,$2,$3,$3,$4,$5,$6)',[id,name,`${name}@test.example`,role==='Reception'?'Sales Employee':role,role,await bcrypt.hash('testpass123',4)]);const agent=request.agent(app);const login=await agent.post('/api/auth/login').send({email:`${name}@test.example`,password:'testpass123'}).expect(200);users[name]={id,agent,csrf:login.body.csrfToken};}
 const source=(await db.query<{id:number}>('SELECT id FROM lead_sources LIMIT 1')).rows[0].id;
 let index=0;
 const create=async(actor='reception',assigned=users.sales.id,extra:Record<string,unknown>={})=>{const u=users[actor];return u.agent.post('/api/leads').set('x-csrf-token',u.csrf).send({name:`Customer ${++index}`,phone:`050900${String(index).padStart(4,'0')}`,sourceId:source,interest:'Apartment',assignedUserId:assigned,...extra});};
 return {db,app,users,source,create};
}

test('own-lead restriction covers bootstrap, search, detail, history writes, tasks, calendar, reports and duplicate disclosure',async()=>{
 const{db,users,create}=await setup();const own=await create();const hidden=await create('reception',users.other.id);assert.equal(own.status,201);assert.equal(hidden.status,201);
 const r=users.reception,s=users.sales;
 const task=await r.agent.post('/api/tasks').set('x-csrf-token',r.csrf).send({title:'Hidden task',leadId:hidden.body.id,dueAt:new Date().toISOString(),assignedUserId:s.id}).expect(201);
 await r.agent.post('/api/calendar-events').set('x-csrf-token',r.csrf).send({title:'Hidden appointment',leadId:hidden.body.id,eventType:'viewing',startsAt:new Date().toISOString(),assignedUserId:s.id}).expect(201);
 const boot=(await s.agent.get('/api/bootstrap').expect(200)).body;assert.deepEqual(boot.leads.items.map((l:{id:number})=>l.id),[own.body.id]);assert.equal(boot.tasks.length,0);assert.equal(boot.calendarEvents.length,0);assert.equal(boot.dashboard.active,1);assert.equal(boot.reports.employees.length,0);
 assert.equal((await s.agent.get(`/api/leads?ownerId=${users.other.id}`).expect(200)).body.total,0);
 await s.agent.get(`/api/leads/${hidden.body.id}`).expect(404);
 await s.agent.patch(`/api/leads/${hidden.body.id}`).set('x-csrf-token',s.csrf).send({version:1,status:'Contacted'}).expect(404);
 await s.agent.post(`/api/leads/${hidden.body.id}/notes`).set('x-csrf-token',s.csrf).send({note:'Forbidden'}).expect(404);
 await s.agent.post(`/api/leads/${hidden.body.id}/interactions`).set('x-csrf-token',s.csrf).send({type:'call',outcome:'Answered',summary:'Forbidden'}).expect(404);
 await s.agent.patch(`/api/tasks/${task.body.id}`).set('x-csrf-token',s.csrf).send({version:1,isCompleted:true}).expect(404);
 await s.agent.get('/api/export/leads.csv').expect(403);await s.agent.get('/api/reports').expect(403);await s.agent.get('/api/audit').expect(403);
 const duplicate=await create('sales',s.id,{phone:'0509000002'});assert.equal(duplicate.status,409);assert.deepEqual(duplicate.body.duplicate,{restricted:true});
 await r.agent.patch(`/api/employees/${s.id}`).set('x-csrf-token',r.csrf).send({version:1,ownLeadsOnly:false}).expect(200);
 assert.equal((await s.agent.get('/api/leads').expect(200)).body.total,2);await s.agent.get(`/api/leads/${hidden.body.id}`).expect(200);
 db.close();
});

test('assignment permissions, reception accounts, management full permissions and durable notification ownership',async()=>{
 const{db,users,create}=await setup();
 assert.equal((await create('reception',users.manager.id)).status,400);assert.equal((await create('manager',users.admin.id)).status,400);
 assert.equal((await create('manager',users.manager.id)).status,201);assert.equal((await create('admin',users.manager.id)).status,400);
 const made=await create();const s=users.sales,r=users.reception;let notices=(await s.agent.get('/api/notifications').expect(200)).body;assert.equal(notices.length,1);
 await users.other.agent.post(`/api/notifications/${notices[0].id}/acknowledge`).set('x-csrf-token',users.other.csrf).expect(200);assert.equal((await s.agent.get('/api/notifications')).body.length,1);
 await r.agent.patch(`/api/leads/${made.body.id}`).set('x-csrf-token',r.csrf).send({version:1,assignedUserId:users.other.id}).expect(200);
 assert.equal((await s.agent.get('/api/notifications')).body.length,0);notices=(await users.other.agent.get('/api/notifications')).body;assert.equal(notices.length,1);
 await users.other.agent.post(`/api/notifications/${notices[0].id}/acknowledge`).set('x-csrf-token',users.other.csrf).expect(200);assert.equal((await users.other.agent.get('/api/notifications')).body.length,0);
 for(const actor of ['reception','manager','admin']){const u=users[actor];await u.agent.post('/api/employees').set('x-csrf-token',u.csrf).send({firstName:'New',lastName:'Reception',displayName:'New Reception',email:`new-${actor}@test.example`,role:'Reception',password:'testpass123'}).expect(201);}
 await users.manager.agent.post('/api/employees').set('x-csrf-token',users.manager.csrf).send({firstName:'New',lastName:'Admin',displayName:'New Admin',email:'new-admin-2@test.example',role:'Administrator',password:'testpass123'}).expect(201);
 db.close();
});

test('requirements, stale highlighting and response time use confirmed communication; lost reason is required',async()=>{
 const{db,users,create}=await setup();const made=await create('reception',users.sales.id,{propertyType:'Apartment',preferredLocation:'Marina',bedrooms:2,budgetMin:50000,budgetMax:90000,moveInDate:'2026-11-01',furnishedPreference:'Furnished'});assert.equal(made.status,201);
 const id=made.body.id;const s=users.sales;
 const ago=new Date(Date.now()-4*86400000).toISOString();await db.query('UPDATE leads SET created_at=$1,updated_at=$1,last_interaction_at=$1 WHERE id=$2',[ago,id]);await db.query('UPDATE lead_status_history SET changed_at=$1 WHERE lead_id=$2',[ago,id]);
 let lead=(await s.agent.get(`/api/leads/${id}`)).body;assert.equal(lead.stale,true);assert.equal(lead.propertyType,'Apartment');assert.equal(lead.budgetMax,90000);
 await s.agent.patch(`/api/leads/${id}`).set('x-csrf-token',s.csrf).send({version:lead.version,budgetMin:100000}).expect(400);
 await s.agent.patch(`/api/leads/${id}`).set('x-csrf-token',s.csrf).send({version:lead.version,status:'Lost'}).expect(400);
 await s.agent.post(`/api/leads/${id}/interactions`).set('x-csrf-token',s.csrf).send({type:'call',outcome:'No answer',summary:'Call outcome: No answer'}).expect(201);
 lead=(await s.agent.get(`/api/leads/${id}`)).body;assert.equal(lead.stale,false);assert.equal(lead.firstContactAt,null);
 await s.agent.post(`/api/leads/${id}/interactions`).set('x-csrf-token',s.csrf).send({type:'call',outcome:'Answered',summary:'Call outcome: Answered'}).expect(201);
 const report=(await users.manager.agent.get('/api/reports')).body;const row=report.responseTimes.find((x:{id:string})=>x.id===s.id);assert.equal(row.contacted,1);assert.ok(row.average_minutes>5700);
 const employees=(await users.manager.agent.get('/api/employees')).body;assert.equal(employees.find((x:{id:string})=>x.id===s.id).uncontactedLeads,0);
 assert.equal((await runMigrations(db)).length,0);db.close();
});

test('filtered CSV exports every match and escapes formulas; concurrent writes do not lose leads',async()=>{
 const{db,app,users,source}=await setup();const r=users.reception;
 const login=await request(app).post('/api/auth/login').send({email:'reception@test.example',password:'testpass123'}).expect(200);
 const cookie=login.headers['set-cookie'];
 const results=await Promise.all(Array.from({length:8},(_,i)=>request(app).post('/api/leads').set('Cookie',cookie).set('x-csrf-token',login.body.csrfToken).send({name:'Concurrent '+i,phone:'050880000'+i,sourceId:source,interest:'Apartment',assignedUserId:users.sales.id})));assert.ok(results.every(x=>x.status===201));
 for(let i=0;i<205;i++)await db.query('INSERT INTO leads(name,phone,source_id,interest,assigned_user_id,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[i===0?'=malicious()':`Export ${i}`,'0500000000',source,'Export target',users.sales.id,r.id,'Qualified']);
 const csv=await users.manager.agent.get('/api/export/leads.csv?q=Export%20target&status=Qualified').expect(200);assert.equal(csv.text.trim().split('\r\n').length,206);assert.ok(csv.text.includes("'=malicious()"));assert.ok(!csv.text.includes('Customer'));
 db.close();
});

test('employee edits persist role, email and password without exposing hashes in audit',async()=>{
 const{db,app,users}=await setup();const m=users.manager,s=users.sales;
 await m.agent.patch(`/api/employees/${s.id}`).set('x-csrf-token',m.csrf).send({version:1,displayName:'Updated Employee',email:'updated@test.example',role:'Reception',password:'Changed2026'}).expect(200);
 await s.agent.get('/api/auth/me').expect(401);
 const login=await request(app).post('/api/auth/login').send({email:'updated@test.example',password:'Changed2026'}).expect(200);
 assert.equal(login.body.user.role,'Reception');assert.equal(login.body.user.displayName,'Updated Employee');
 const audit=(await m.agent.get('/api/audit')).body;const serialized=JSON.stringify(audit);assert.ok(!serialized.includes('Changed2026'));assert.ok(!serialized.includes('$2b$'));
 db.close();
});
