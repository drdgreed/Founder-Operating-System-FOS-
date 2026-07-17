import { eq } from "drizzle-orm";
import { fosWorkspace } from "../../schema/fos_workspace.js";
import { product } from "../../schema/product.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";
import { person } from "../../schema/person.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { computeContentHash } from "../content-hash.js";
import type { ArtifactStatus } from "../artifact-transitions.js";
import type { Db } from "../types.js";

export async function seedWorkspaceAndProduct(db: Db) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedWorkspaceAndProduct: fos_workspace insert returned no row");

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
  if (!top) throw new Error("seedWorkspaceAndProduct: product insert returned no row");

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
  if (!row) throw new Error("seedPerson: person insert returned no row");
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
  if (!row) throw new Error("seedOpportunity: enrollment_opportunity insert returned no row");
  return row;
}

/**
 * Seeds an ArtifactRecord + a single ArtifactVersion (v1) directly in the
 * given lifecycle status, with the record's current_version_id + status mirror
 * pointed at that version. Used by the full §12.2 matrix test to place a
 * current version in an arbitrary `from` state, bypassing the service.
 */
export async function seedArtifactWithStatus(
  db: Db,
  input: {
    workspaceId: string;
    productId?: string | null;
    status: ArtifactStatus;
    bodyMarkdown?: string;
  },
) {
  const body = input.bodyMarkdown ?? "# Draft body\n";
  const [record] = await db
    .insert(artifactRecord)
    .values({
      workspaceId: input.workspaceId,
      productId: input.productId ?? null,
      artifactType: "internal_note",
      domain: "editorial",
      title: "Seeded artifact",
      status: input.status,
      currentVersionId: null,
    })
    .returning();
  if (!record) throw new Error("seedArtifactWithStatus: artifact_record insert returned no row");

  const [version] = await db
    .insert(artifactVersion)
    .values({
      workspaceId: input.workspaceId,
      artifactId: record.id,
      versionNumber: 1,
      bodyMarkdown: body,
      contentHash: computeContentHash(body),
      approvalStatus: input.status,
    })
    .returning();
  if (!version) throw new Error("seedArtifactWithStatus: artifact_version insert returned no row");

  await db
    .update(artifactRecord)
    .set({ currentVersionId: version.id })
    .where(eq(artifactRecord.id, record.id));

  return { record, version };
}
