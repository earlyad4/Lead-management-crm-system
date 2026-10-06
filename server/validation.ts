import { z } from "zod";
import { LEAD_STATUSES, PRIORITIES, ROLES } from "./domain.js";

const optionalText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();
const optionalEmail = z.union([z.string().trim().email().max(254), z.literal(""), z.null()]).optional();
const nullableDate = z.union([z.string().datetime({ offset: true }), z.null()]).optional();
const budget = z.union([z.number().nonnegative().max(999_999_999_999), z.null()]).optional();

export const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(8).max(200) });

const requirements = {
  propertyType: optionalText(120), preferredLocation: optionalText(250),
  bedrooms: z.number().int().min(0).max(100).nullable().optional(),
  budgetMin: budget, budgetMax: budget,
  furnishedPreference: z.enum(['Furnished','Unfurnished','Partly furnished','No preference']).nullable().optional(),
  moveInDate: z.string().date().nullable().optional(),
};
export const leadCreateSchema = z.object({
  ...requirements,
  name: z.string().trim().min(2).max(160),
  phone: optionalText(40),
  email: optionalEmail,
  sourceId: z.coerce.number().int().positive(),
  interest: z.string().trim().min(2).max(500),
  budget,
  notes: z.string().trim().max(5000).optional().default(""),
  assignedUserId: z.union([z.string().uuid(), z.null()]).optional().default(null),
  priority: z.enum(PRIORITIES).optional().default("Normal"),
  nextFollowUpAt: nullableDate,
  duplicateOverride: z.boolean().optional().default(false),
}).refine((data) => Boolean(data.phone || data.email), { message: "A phone number or email address is required.", path: ["phone"] });

export const leadPatchSchema = z.object({
  ...requirements,
  version: z.number().int().positive(),
  name: z.string().trim().min(2).max(160).optional(),
  phone: optionalText(40),
  email: optionalEmail,
  sourceId: z.coerce.number().int().positive().optional(),
  interest: z.string().trim().min(2).max(500).optional(),
  budget,
  notes: z.string().trim().max(5000).optional(),
  assignedUserId: z.union([z.string().uuid(), z.null()]).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  nextFollowUpAt: nullableDate,
  wonAmount: budget,
  closingNote: optionalText(5000),
  lostReasonId: z.union([z.number().int().positive(), z.null()]).optional(),
  lostNote: optionalText(5000),
}).superRefine((value,context)=>{
  if(value.status==="Won"&&(value.lostReasonId!==undefined||value.lostNote!==undefined))context.addIssue({code:"custom",message:"Lost details cannot be supplied when marking a lead Won.",path:["status"]});
  if(value.status==="Lost"&&(value.wonAmount!==undefined||value.closingNote!==undefined))context.addIssue({code:"custom",message:"Won details cannot be supplied when marking a lead Lost.",path:["status"]});
});

export const noteSchema = z.object({ note: z.string().trim().min(1).max(5000) });
export const interactionSchema = z.object({ type: z.enum(["call","whatsapp","email","meeting","viewing"]), summary: z.string().trim().min(1).max(1000), outcome: z.enum(["Answered","No answer","Call back later","Not interested","Wrong number"]).optional() });

export const taskCreateSchema = z.object({
  title: z.string().trim().min(2).max(300),
  leadId: z.union([z.number().int().positive(), z.null()]).optional().default(null),
  dueAt: z.string().datetime({ offset: true }),
  assignedUserId: z.string().uuid(),
  notes: z.string().trim().max(3000).optional().default(""),
});
export const taskPatchSchema = z.object({ version: z.number().int().positive(), isCompleted: z.boolean().optional(), title: z.string().trim().min(2).max(300).optional(), dueAt: z.string().datetime({ offset: true }).optional(), assignedUserId: z.string().uuid().optional(), notes: z.string().trim().max(3000).optional() }).refine((value)=>Object.keys(value).some((key)=>key!=="version"),{message:"No task changes were supplied."});

export const employeeCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), displayName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254), phone: optionalText(40), ownLeadsOnly: z.boolean().optional().default(true), role: z.enum(ROLES), password: z.string().min(8).max(200),
});
export const employeePatchSchema = z.object({ ownLeadsOnly: z.boolean().optional(), password: z.string().min(8).max(200).optional(), version: z.number().int().positive(), firstName: z.string().trim().min(1).max(80).optional(), lastName: z.string().trim().min(1).max(80).optional(), displayName: z.string().trim().min(2).max(160).optional(), email: z.string().trim().email().max(254).optional(), phone: optionalText(40), role: z.enum(ROLES).optional(), isActive: z.boolean().optional() }).refine((value)=>Object.keys(value).some((key)=>key!=="version"),{message:"No employee changes were supplied."});
export const deactivateEmployeeSchema = z.object({ transferToUserId: z.string().uuid().optional() });

export const settingsSchema = z.object({
  messageTemplates: z.array(z.object({id:z.string().min(1).max(80),name:z.string().trim().min(1).max(100),body:z.string().trim().min(1).max(4000)})).min(1).max(30).optional(),
  company: z.object({ companyName: z.string().trim().min(2).max(160), timezone: z.string().trim().min(1).max(80), currency: z.string().trim().length(3), internalUrl: z.string().trim().max(500) }).optional(),
  attentionRules: z.object({ highlightStale: z.boolean().optional().default(true), newLeadHours: z.number().int().min(1).max(720), inactiveLeadHours: z.number().int().min(1).max(2160), flagMissingFollowUp: z.boolean(), flagUnassigned: z.boolean() }).optional(),
}).refine((value)=>Object.keys(value).length>0,{message:"No settings changes were supplied."});

export const calendarEventCreateSchema = z.object({
  title: z.string().trim().min(2).max(300),
  leadId: z.number().int().positive(),
  eventType: z.enum(["viewing","meeting"]),
  startsAt: z.string().datetime({ offset:true }),
  endsAt: z.union([z.string().datetime({ offset:true }),z.null()]).optional().default(null),
  assignedUserId: z.string().uuid(),
}).refine((value)=>!value.endsAt||new Date(value.endsAt)>new Date(value.startsAt),{message:"End time must be after start time.",path:["endsAt"]});
