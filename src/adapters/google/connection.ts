import type { ProviderCapability, ProviderConnectionPort } from '@/core/ports/provider-connection';
import {
  CALENDAR_ACL_SCOPE,
  CALENDAR_SCOPE,
  DRIVE_IMPORT_SCOPE,
  DRIVE_SCOPE,
  GMAIL_SEND_SCOPE,
  buildConsentUrl,
  exchangeCode,
} from './oauth';
import { getGrantedScopes, storeGoogleGrant } from './tokens';

/** Google's implementation of the consent flow (DESIGN.md §3.4). */

const SCOPES: Record<ProviderCapability, string> = {
  storage: DRIVE_SCOPE,
  calendar: CALENDAR_SCOPE,
  /**
   * Drive sharing needs nothing extra — `drive.file` already permits `permissions.create`
   * on folders the app created, measured against the live API (DESIGN.md §12). Only the
   * calendar half needs a new grant, so that is all this capability asks for.
   */
  sharing: CALENDAR_ACL_SCOPE,
  /** Send only. It cannot read the mailbox, which is the entire reason it was chosen. */
  email: GMAIL_SEND_SCOPE,
  /**
   * Reading folders `drive.file` cannot see. The widest grant here, asked for last and only
   * on request — see `DRIVE_IMPORT_SCOPE` for the containment and the published-app cost.
   */
  import: DRIVE_IMPORT_SCOPE,
};

export class GoogleConnection implements ProviderConnectionPort {
  buildConsentUrl(input: {
    redirectUri: string;
    state: string;
    capabilities: readonly ProviderCapability[];
  }): string {
    return buildConsentUrl({
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: input.capabilities.map((capability) => SCOPES[capability]),
    });
  }

  async completeConsent(input: {
    code: string;
    redirectUri: string;
    userId: string;
    capabilities: readonly ProviderCapability[];
  }): Promise<{ granted: boolean }> {
    const tokens = await exchangeCode({ code: input.code, redirectUri: input.redirectUri });

    // Google returns 200 with a narrower scope set when the user unticks a permission,
    // so a successful exchange is not by itself proof the app can reach the resource.
    const granted = new Set(tokens.scope.split(' '));
    if (!input.capabilities.every((capability) => granted.has(SCOPES[capability]))) {
      return { granted: false };
    }

    await storeGoogleGrant({
      userId: input.userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });

    return { granted: true };
  }

  async grantedCapabilities(input: { userId: string }): Promise<ProviderCapability[]> {
    const scopes = await getGrantedScopes(input.userId);
    return (Object.keys(SCOPES) as ProviderCapability[]).filter((capability) =>
      scopes.has(SCOPES[capability]),
    );
  }
}
