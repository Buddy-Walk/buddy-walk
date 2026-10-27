import { canRunLocalLastMile } from "../config/serverMode";
import { deployedCommit, type LastMetersRequestInput } from "../utils/lastMileReplay";
import {
  mobileLastMileGuidancePolicy,
  MOBILE_LAST_MILE_GUIDANCE_VERSION,
  strictLastMileGuidancePolicy,
  type LastMileGuidancePolicy,
} from "../utils/lastMileGuidancePolicy";
import { LastMetersService, type LastMetersRunOptions, type LastMetersRunResult } from "./lastMetersService";

export const MOBILE_REVIEW_PANORAMA_VERSION = MOBILE_LAST_MILE_GUIDANCE_VERSION;

/** Identify the deployed mobile guidance policy without creating a trial or calling a provider. */
export function mobileReviewPanoramaStatus() {
  return {
    version: MOBILE_REVIEW_PANORAMA_VERSION,
    deployedCommit: deployedCommit(),
    enabled: canRunLocalLastMile(),
  };
}

/** Run complete field analysis before deciding whether mobile evidence supports a precise turn. */
export class MobileLastMileService extends LastMetersService {
  /** Keep every retry and pinned execution on its existing shared policy. */
  protected override lastMileGuidancePolicy(options: LastMetersRunOptions): LastMileGuidancePolicy {
    return options.retry || options.pinnedPanorama
      ? strictLastMileGuidancePolicy
      : mobileLastMileGuidancePolicy;
  }

  /** Identify non-turn answers so earlier iOS builds display them without applying a turn-only check. */
  override async runLastMeters(
    request: LastMetersRequestInput,
    image: string,
    options: LastMetersRunOptions = {},
  ): Promise<LastMetersRunResult> {
    const result = await super.runLastMeters(request, image, options);
    if (
      options.retry || options.pinnedPanorama || result.kind !== "response" ||
      result.status !== 200 || Number.isFinite(result.body.targetHeading) ||
      result.body.guidanceKind === "withheld"
    ) return result;
    return { ...result, body: { ...result.body, guidanceKind: "withheld", targetHeading: null } };
  }
}
