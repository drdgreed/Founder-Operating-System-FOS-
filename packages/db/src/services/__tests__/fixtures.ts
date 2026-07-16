import { fosWorkspace } from "../../schema/fos_workspace.js";
import { product } from "../../schema/product.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";
import { person } from "../../schema/person.js";
import type { Db } from "../types.js";

export async function seedWorkspaceAndProduct(db: Db) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();

  const [top] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: "career-foundry",
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();

  return { workspace, product: top };
}

export async function seedPerson(
  db: Db,
  workspaceId: string,
  overrides: Partial<typeof person.$inferInsert> = {},
) {
  const [row] = await db
    .insert(person)
    .values({
      workspaceId,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      source: "website_application",
      lifecycleType: "applicant",
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedOpportunity(
  db: Db,
  input: { workspaceId: string; productId: string; personId: string; stage?: string },
) {
  const [row] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: input.workspaceId,
      productId: input.productId,
      personId: input.personId,
      stage: (input.stage ?? "new_lead") as (typeof enrollmentOpportunity.$inferInsert)["stage"],
      currency: "USD",
      version: 1,
    })
    .returning();
  return row;
}
