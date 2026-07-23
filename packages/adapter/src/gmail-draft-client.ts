/**
 * Mockable seam for the "Create Gmail draft" controlled command (spec §7.3,
 * §9.4 step 10 / §9.1 step 10 — "Create external email draft only after
 * approval"). This slice (P1.8b, issue #117) builds the command against this
 * INTERFACE only; the executor never touches a real Gmail API.
 *
 * SECURITY / DEFERRED ACTIVATION: the live Gmail OAuth + Drafts API integration
 * (`gmail.googleapis.com/gmail/v1/users/me/drafts`) is a SEPARATE, deferred
 * activation slice. It — not this one — is the place that handles OAuth tokens,
 * credential storage, and scopes. Nothing in this file (or its executor) reads,
 * stores, or transmits a credential, and NO real network call is made here. The
 * command creates a DRAFT only; it NEVER sends mail.
 */

export interface GmailDraftInput {
  /** Recipient address(es), from the approved artifact's recipient context. */
  to: string;
  subject: string;
  /** Draft body — built from the approved artifact's current version content. */
  body: string;
}

export interface GmailDraftResult {
  /** The provider draft id (e.g. Gmail `draft.id`) — recorded on the executed event. */
  draftId: string;
}

/**
 * The single capability the command depends on: create an external email DRAFT
 * (never send). Tests supply a fake; the live implementation lands with the
 * deferred Gmail OAuth/API activation slice.
 */
export interface GmailDraftClient {
  createDraft(input: GmailDraftInput): Promise<GmailDraftResult>;
}

/**
 * Placeholder wired wherever a `GmailDraftClient` is required until the live
 * Gmail OAuth/API integration slice ships. It THROWS on use by design — a
 * fail-closed default so a misconfigured deployment can never silently no-op a
 * founder-approved draft, and so no accidental un-mocked call slips through in
 * a non-test path. It handles no credentials and makes no network call.
 */
export class NotImplementedGmailDraftClient implements GmailDraftClient {
  createDraft(_input: GmailDraftInput): Promise<GmailDraftResult> {
    void _input;
    return Promise.reject(
      new Error(
        "GmailDraftClient is not implemented: the live Gmail OAuth/API integration is a " +
          "deferred activation slice (issue #117 builds the command against the interface only).",
      ),
    );
  }
}
