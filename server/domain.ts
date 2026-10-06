export const LEAD_STATUSES = ["New", "Contacted", "Qualified", "Viewing / Meeting", "Follow-up", "Won", "Lost"] as const;
export const PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
export const ROLES = ["Administrator", "Manager", "Reception", "Sales Employee"] as const;
export const ACTIVE_STATUSES = LEAD_STATUSES.slice(0, 5);

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Role = (typeof ROLES)[number];

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 10) digits = `971${digits.slice(1)}`;
  return digits;
}

export function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}

export function leadReference(id: string | number): string {
  return `LEAD-${String(id).padStart(6, "0")}`;
}
