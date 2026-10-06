import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getPool } from "../server/db.js";
import { normalizeEmail } from "../server/domain.js";
import { runMigrations } from "../server/migrate.js";

const email = normalizeEmail(process.env.ADMIN_EMAIL);
const password = typeof process.env.ADMIN_PASSWORD === "string" ? process.env.ADMIN_PASSWORD : "";
const displayName = typeof process.env.ADMIN_NAME === "string" ? process.env.ADMIN_NAME.trim() : "";

if (!email || !displayName || password.length < 8) {
  process.stderr.write("Set ADMIN_EMAIL, ADMIN_NAME, and ADMIN_PASSWORD (minimum 8 characters) before running this command.\n");
  process.exit(1);
}

const pool = getPool();
await runMigrations(pool);
const names = displayName.split(/\s+/);
const firstName = names[0];
const lastName = names.slice(1).join(" ") || "Administrator";
const passwordHash = await bcrypt.hash(password, 12);
const existing = await pool.query<{ id:string }>("SELECT id FROM users WHERE normalized_email=$1",[email]);
if (existing.rows[0]) {
  await pool.query("UPDATE users SET display_name=$1,first_name=$2,last_name=$3,password_hash=$4,role='Administrator',account_role='Administrator',is_active=TRUE,version=version+1,updated_at=NOW() WHERE id=$5",[displayName,firstName,lastName,passwordHash,existing.rows[0].id]);
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [existing.rows[0].id]);
  process.stdout.write(`Administrator ${email} updated.\n`);
} else {
  await pool.query("INSERT INTO users (id,first_name,last_name,display_name,normalized_email,email,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6,'Administrator',$7)",[randomUUID(),firstName,lastName,displayName,email,email,passwordHash]);
  process.stdout.write(`Administrator ${email} created.\n`);
}
await pool.end();
