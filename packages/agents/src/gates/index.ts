export * from "./gate.js";
export * from "./no-prohibited-value.js";
export * from "./feature-mode-allowed.js";
export * from "./facts-resolve-to-sources.js";
export * from "./recommended-pathway-available.js";
export * from "./stage-proposal-legal.js";
export * from "./observed-objection-has-source.js";
export * from "./consent.js";
export * from "./cooldown.js";
export * from "./lifecycle-legal.js";
export * from "./no-duplicate-task.js";
export * from "./no-scheduled-activity-conflict.js";
export * from "./not-terminal-status.js";
export * from "./offer-available.js";
export * from "./claims-in-approved-set.js";
// P1.8a (issue #116): the fuller deterministic compliance gate library.
// LIBRARY gates — exported for import, NOT wired into any agent's gate list yet
// (that migration is a follow-up decision, see PR/issue #116).
export * from "./claims-approved-for-channel-and-offer.js";
export * from "./contact-consent.js";
export * from "./platform-draft.js";
// Option C slice 1 (issue #106): semantic guarantee classifier. Standalone —
// exported for import, NOT registered into any pipeline/gate list (that is slice 2).
export * from "./guarantee-classifier.js";
