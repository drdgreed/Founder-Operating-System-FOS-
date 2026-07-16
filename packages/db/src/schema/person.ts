import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";

/**
 * Person (spec §9.2). Founder-level entity — NO `product_id` column
 * (PATCH-SET-01 §B0 scoping taxonomy lists Person explicitly as
 * founder-level).
 */
export const personSourceEnum = pgEnum("person_source", [
  "website_application",
  "website_lead_form",
  "referral",
  "linkedin",
  "email",
  "event",
  "webinar",
  "manual",
  "existing_user",
  "other",
]);

export const personLifecycleEnum = pgEnum("person_lifecycle_type", [
  "lead",
  "applicant",
  "beta_user",
  "customer",
  "partner",
  "contact",
]);

// PATCH-SET-01 §S2 proposed value set.
export const personPrivacyClassificationEnum = pgEnum("person_privacy_classification", [
  "standard",
  "sensitive",
  "restricted",
]);

export const person = pgTable("person", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => fosWorkspace.id),
  existingUserId: text("existing_user_id"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  preferredName: text("preferred_name"),
  email: text("email"),
  phone: text("phone"),
  currentRole: text("current_role"),
  currentCompany: text("current_company"),
  location: text("location"),
  linkedinUrl: text("linkedin_url"),
  portfolioUrl: text("portfolio_url"),
  source: personSourceEnum("source").notNull(),
  sourceDetail: text("source_detail"),
  lifecycleType: personLifecycleEnum("lifecycle_type").notNull(),
  privacyClassification: personPrivacyClassificationEnum("privacy_classification")
    .notNull()
    .default("standard"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
