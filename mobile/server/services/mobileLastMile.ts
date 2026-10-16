import OpenAI from "openai";
import { parseLastMetersInput } from "../../src/utils/lastMetersInput";
import { sensorSafetyReasons, validPoint } from "../../src/utils/lastMileSafety";
import { canRunLocalLastMile } from "../config/serverMode";
import { deployedCommit, type LastMetersRequestInput } from "../utils/lastMileReplay";
import {
  OpenAIService,
  classifyPanoramaScene,
  processPanoramaTiles,
  saveBackgroundPanorama,
  type LastMetersRunOptions,
  type LastMetersRunResult,
} from "./openAI";

export const MOBILE_REVIEW_PANORAMA_VERSION = "1.0.0";

interface CaptureLocation {
  lat: number;
  lng: number;
}

type ReviewPanoramaDownloader = (location: CaptureLocation) => ReturnType<typeof processPanoramaTiles>;
type ReviewPanoramaSaver = (testLogId: string, location: CaptureLocation) => Promise<void>;

/** Download review imagery from the original position using the existing outdoor validation. */
async function downloadReviewPanorama(location: CaptureLocation) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return processPanoramaTiles(
    location.lat,
    location.lng,
    /** Classify camera location only; this background work never calculates a turn. */
    (images, timeoutMs) => classifyPanoramaScene(client, images, timeoutMs),
  );
}

/** Attach validated review imagery or an explicit download failure to the original field trial. */
export async function saveFieldReviewPanorama(
  testLogId: string,
  location: CaptureLocation,
  download: ReviewPanoramaDownloader = downloadReviewPanorama,
): Promise<void> {
  return saveBackgroundPanorama(
    testLogId,
    // Convert a synchronous provider failure into the same persisted failure path as a rejection.
    Promise.resolve().then(() => download(location)),
  );
}

/** Expose the deployed adapter version without creating a trial or making a provider request. */
export function mobileReviewPanoramaStatus() {
  return {
    version: MOBILE_REVIEW_PANORAMA_VERSION,
    deployedCommit: deployedCommit(),
    enabled: canRunLocalLastMile(),
  };
}

/**
 * Add review imagery to new mobile captures rejected at the initial sensor gate.
 * The shared pipeline and Mykael's retry service continue to use OpenAIService unchanged.
 */
export class MobileLastMileService extends OpenAIService {
  /** Allow the background saver to be replaced in tests without changing shared execution. */
  constructor(private readonly saveReview: ReviewPanoramaSaver = saveFieldReviewPanorama) {
    super();
  }

  /** Return the original safety result promptly, then save review imagery outside the answer. */
  override async runLastMeters(
    request: LastMetersRequestInput,
    image: string,
    options: LastMetersRunOptions = {},
  ): Promise<LastMetersRunResult> {
    const location = { lat: request.lat, lng: request.lng };
    const needsReview =
      !options.retry &&
      !options.pinnedPanorama &&
      validPoint(location) &&
      parseLastMetersInput(request.destination).kind === "destination" &&
      sensorSafetyReasons(
        request.sensors,
        location,
        request.deviceHeading,
        request.gpsAccuracyMeters,
      ).length > 0;

    const result = await super.runLastMeters(request, image, options);
    if (
      !needsReview ||
      result.kind !== "response" ||
      result.status !== 200 ||
      result.body.guidanceKind !== "withheld" ||
      result.body.warning !== "turn_withheld" ||
      !result.testLogId ||
      result.reviewPanorama
    ) {
      return result;
    }

    const testLogId = result.testLogId;
    const reviewPanorama = new Promise<void>((resolve) => {
      // Let the inherited mobile handler send its response before any provider work starts.
      setImmediate(async () => {
        // Contain storage/provider failures after the answer has already been returned.
        try {
          await this.saveReview(testLogId, location);
        } catch {
          console.error("[MobileLastMile] Could not attach review panorama to trial", testLogId);
        } finally {
          resolve();
        }
      });
    });
    return { ...result, reviewPanorama };
  }
}
