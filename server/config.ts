import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_FILE: z.string().min(1).default(path.resolve(process.cwd(), "database", "LeadCRM.db")),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRONTEND_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
});

export type AppConfig = z.infer<typeof schema>;

export function getConfig(): AppConfig {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration. ${missing}`);
  }
  return result.data;
}
