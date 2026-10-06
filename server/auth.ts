import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database } from "./db.js";
import type { Role } from "./domain.js";

export const SESSION_COOKIE = "lead_crm_session";

export type AuthUser = {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  ownLeadsOnly?: boolean;
};

export type AuthContext = {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function sessionDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Database, userId: string, ipAddress: string | undefined, sessionHours: number) {
  const rawToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000);
  await db.query(
    "INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, userId, sessionDigest(rawToken), csrfToken, ipAddress ?? null, expiresAt],
  );
  return { id, rawToken, csrfToken, expiresAt };
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authMiddleware(db: Database): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const token = typeof request.cookies?.[SESSION_COOKIE] === "string" ? request.cookies[SESSION_COOKIE] : "";
      if (!token) return response.status(401).json({ error: "Authentication required." });
      const result = await db.query<{
        session_id: string; csrf_token: string; id: string; display_name: string; email: string; role: Role; own_leads_only: number;
      }>(`SELECT s.id AS session_id, s.csrf_token, u.id, u.display_name, u.email, COALESCE(u.account_role,u.role) AS role, u.own_leads_only
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`, [sessionDigest(token)]);
      const row = result.rows[0];
      if (!row) {
        response.clearCookie(SESSION_COOKIE);
        return response.status(401).json({ error: "Your session has expired. Please sign in again." });
      }
      request.auth = { sessionId: row.session_id, csrfToken: row.csrf_token, user: { id: row.id, displayName: row.display_name, email: row.email, role: row.role, ownLeadsOnly: Boolean(row.own_leads_only) } };
      next();
    } catch (error) { next(error); }
  };
}

export function csrfMiddleware(request: Request, response: Response, next: NextFunction) {
  const supplied = typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : "";
  const expected = request.auth?.csrfToken ?? "";
  if (!supplied || !expected || !constantTimeEqual(supplied, expected)) return response.status(403).json({ error: "Security token validation failed. Refresh and retry." });
  next();
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (request, response, next) => request.auth && roles.includes(request.auth.user.role)
    ? next()
    : response.status(403).json({ error: "You do not have permission to perform this action." });
}

export function cookieOptions(production: boolean, expires: Date) {
  return { httpOnly: true, sameSite: "strict" as const, secure: production, path: "/", expires };
}
