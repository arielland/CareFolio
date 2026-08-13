/**
 * Granting the app access to the space's provider account.
 *
 * This exists as a port because the alternative was letting the connect route import
 * the Google adapter directly — which the boundary lint correctly rejected. Consent is
 * a real capability with a provider-shaped implementation, the same as upload or
 * download, so it belongs behind an interface like the rest (DESIGN.md §2, §3.4).
 *
 * A provider needing no user consent (app-owned S3) implements this trivially: return
 * a URL that goes straight back, and report success.
 */

/**
 * What the admin is being asked to approve. Consent is *incremental* (DESIGN.md §11):
 * Drive is requested when storage is connected, the calendar only when M2 needs it,
 * `sharing` only when a first member is actually invited — and a space can legitimately
 * have any one without the others. The port speaks in capabilities rather than scope
 * strings so the modules above it never learn Google's vocabulary.
 *
 * `sharing` is separate from `calendar` because of a measured Google constraint, not a
 * modelling preference: the narrow calendar scope cannot touch a calendar's ACL at all
 * (DESIGN.md §12), so sharing the space calendar needs its own grant. Keeping it separate
 * means a space that never invites anyone never asks for it. `email` follows the same rule
 * and is asked for the first time someone writes to the kupah.
 *
 * `import` is the widest of them and the last to be added: reading a folder of documents the
 * app did not create is something `storage` provably cannot do, so bulk-importing from the
 * admin's existing Drive needs its own grant. It is asked for when an admin opens the import
 * screen and chooses Drive — never at sign-up, never as part of connecting storage — and a
 * space that only ever scans with the camera never grants it. See `DRIVE_IMPORT_SCOPE` in
 * `adapters/google/oauth.ts` for what it costs and why there is no narrower option.
 */
export type ProviderCapability = 'storage' | 'calendar' | 'sharing' | 'email' | 'import';

export interface ProviderConnectionPort {
  /** Where to send the admin to approve access. `state` is echoed back to the callback. */
  buildConsentUrl(input: {
    redirectUri: string;
    state: string;
    capabilities: readonly ProviderCapability[];
  }): string;

  /**
   * Exchanges the callback code for durable credentials and stores them against the
   * user. Returns whether the grant actually covered what was asked for — a user can
   * approve one capability while unticking another.
   */
  completeConsent(input: {
    code: string;
    redirectUri: string;
    userId: string;
    capabilities: readonly ProviderCapability[];
  }): Promise<{ granted: boolean }>;

  /**
   * What this account has already approved. Screens use it to ask for a capability at the
   * moment it is first needed and never again — the alternative is inferring consent from
   * a failed API call, which means every prompt arrives one broken action too late.
   */
  grantedCapabilities(input: { userId: string }): Promise<ProviderCapability[]>;
}
