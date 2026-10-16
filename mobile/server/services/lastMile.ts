import axios from "axios";
import OpenAI from "openai";
import sharp from "sharp";
import { AppContext } from "../types";
import { LAST_MILE_HEADINGS, LAST_MILE_PANORAMA_FOV_DEGREES } from "../utils/lastMileNavigation";
import { outdoorPanoramaRejection } from "../utils/outdoorPanorama";

const HEADINGS = LAST_MILE_HEADINGS;
const DEFAULT_CONFIDENCE_THRESHOLD = 70;
const PANORAMA_RETRY_COUNT = 2;
const APPROX_METERS_PER_BLOCK = 80;

type TargetPosition = "left" | "center" | "right" | "unknown";

interface PanoramaTile {
  heading: number;
  base64: string;
}

interface PanoramaMetadataResponse {
  status: string;
  copyright?: string;
  pano_id?: string;
  location?: {
    lat: number;
    lng: number;
  };
  error_message?: string;
}

interface ComparisonResult {
  heading: number;
  match: boolean;
  matchedAngle: number;
  confidence: number;
  position: TargetPosition;
}

interface ComparisonEnvelope {
  comparisons: ComparisonResult[];
}

interface GuidanceResult {
  guidance: string;
  confidence: number;
}

interface PlaceCandidate {
  name: string;
  address: string;
  placeId: string;
  walkingDistance: string;
  walkingDistanceMeters: number;
  estimatedBlocks: number;
}

/**
 * Coerce a model confidence value to a bounded integer percentage, using zero when it is not
 * finite.
 */
function clampConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

/** Wrap an angle into the zero-inclusive, 360-exclusive compass range. */
function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Measure the shortest circular angular separation between two headings. */
function circularDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(diff, 360 - diff);
}

/**
 * Average two headings across their shortest arc so wraparound does not point in the opposite
 * direction.
 */
function circularAverage(a: number, b: number): number {
  const first = normalizeHeading(a);
  const second = normalizeHeading(b);
  const diff = ((second - first + 540) % 360) - 180;
  return normalizeHeading(first + diff / 2);
}

/**
 * Estimate a small angular offset from the target's left/center/right position within a panorama
 * tile.
 */
function positionOffset(position: TargetPosition): number {
  if (position === "left") return -LAST_MILE_PANORAMA_FOV_DEGREES / 3;
  if (position === "right") return LAST_MILE_PANORAMA_FOV_DEGREES / 3;
  return 0;
}

/**
 * Select confident visual matches and refine the best angle with an adjacent matched tile when
 * available.
 */
function selectBestAngle(
  comparisons: ComparisonResult[],
  confidenceThreshold: number,
): { angle: number; confidence: number; matches: ComparisonResult[] } | null {
  const matches = comparisons
    .filter(/* Keep only positive comparisons meeting the configured confidence threshold. */ (item) => item.match && item.confidence >= confidenceThreshold)
    .sort(/* Consider the highest-confidence visual comparison first. */ (a, b) => b.confidence - a.confidence);

  if (matches.length === 0) return null;

  const best = matches[0];
  let angle = normalizeHeading(best.matchedAngle + positionOffset(best.position));

  const adjacent = matches.find(
    /** Find a second matched tile immediately adjacent to the strongest match. */
    (candidate, index) => index > 0 && circularDistance(best.matchedAngle, candidate.matchedAngle) === LAST_MILE_PANORAMA_FOV_DEGREES,
  );

  if (adjacent) {
    angle = circularAverage(best.matchedAngle, adjacent.matchedAngle);
  }

  return {
    angle,
    confidence: best.confidence,
    matches,
  };
}

/**
 * Translate a pair of headings into the shortest left/right/straight turn and a half-hour
 * clock-face description.
 */
function turnToClockPosition(currentHeading: number, targetHeading: number): {
  direction: "LEFT" | "RIGHT" | "STRAIGHT";
  degrees: number;
  clockPosition: string;
  instruction: string;
} {
  let diff = normalizeHeading(targetHeading) - normalizeHeading(currentHeading);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  const roundedDegrees = Math.round(Math.abs(diff));
  const direction = Math.abs(diff) < 7.5 ? "STRAIGHT" : diff > 0 ? "RIGHT" : "LEFT";

  const signedClockDegrees = direction === "STRAIGHT" ? 0 : diff;
  const halfHourSteps = Math.round(signedClockDegrees / 15);
  const normalizedSteps = ((halfHourSteps % 24) + 24) % 24;
  const hour = Math.floor(normalizedSteps / 2);
  const minute = normalizedSteps % 2 === 0 ? "00" : "30";
  const displayHour = hour === 0 ? 12 : hour;
  const clockPosition = minute === "00" ? `${displayHour} o'clock` : `${displayHour}:${minute}`;

  if (direction === "STRAIGHT") {
    return {
      direction,
      degrees: 0,
      clockPosition: "12 o'clock",
      instruction: "The target is in your 12 o'clock direction.",
    };
  }

  return {
    direction,
    degrees: roundedDegrees,
    clockPosition,
    instruction: `Turn ${direction.toLowerCase()} about ${roundedDegrees}°. The target is in your ${clockPosition} direction.`,
  };
}

/** Read either supported Maps credential setting without exposing the key in a response. */
function googleMapsApiKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
}

export class LastMileService {
  private readonly client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  /**
   * Bound the configured legacy visual-match threshold to a percentage, using its default for
   * nonnumeric input.
   */
  private get confidenceThreshold(): number {
    const configured = Number(process.env.AI_CONFIDENCE_THRESHOLD);
    if (!Number.isFinite(configured)) return DEFAULT_CONFIDENCE_THRESHOLD;
    return Math.max(0, Math.min(100, configured));
  }

  /**
   * Run the legacy visual-comparison service: validate panorama tiles, match the photo and
   * destination, and return uncertain or confirmation-required outcomes when evidence is
   * insufficient.
   */
  async handle(
    ctx: AppContext,
    lat: number,
    lng: number,
    image: string,
    destination: string,
  ): Promise<void> {
    const { res } = ctx;

    try {
      const tiles = await this.fetchValidatedPanoramaTiles(lat, lng);
      if (!tiles) {
        res.status(422).json({
          code: "PANORAMA_UNUSABLE",
          retryable: true,
          output:
            "Based on Google Street View imagery, I could not get a usable panorama after two attempts. Please walk a few meters and take another photo.",
          sources: ["Google Street View imagery"],
        });
        return;
      }

      const currentViewComparisons = await this.compareCurrentPhotoToPanorama(image, tiles);
      const currentView = selectBestAngle(currentViewComparisons, this.confidenceThreshold);

      if (!currentView) {
        res.status(200).json({
          code: "LOW_CONFIDENCE_CURRENT_VIEW",
          uncertain: true,
          output:
            "Based on AI image comparison, I am not confident enough to determine which Street View direction matches your photo. Please take another photo from your current position.",
          confidence: Math.max(...currentViewComparisons.map(/* Read each photo-match confidence to report the strongest result when no current view passes the threshold. */ (item) => item.confidence), 0),
          sources: ["AI image comparison", "Google Street View imagery"],
          comparisons: currentViewComparisons,
        });
        return;
      }

      const targetComparisons = await this.findDestinationInPanorama(destination, tiles);
      const target = selectBestAngle(targetComparisons, this.confidenceThreshold);

      if (!target) {
        const candidate = await this.findPlaceCandidate(lat, lng, destination);
        if (!candidate) {
          res.status(200).json({
            code: "DESTINATION_NOT_FOUND",
            requiresConfirmation: true,
            uncertain: true,
            output:
              `Based on Google Street View imagery and AI storefront recognition, I could not identify ${destination} nearby. I also could not find a relevant Google Places result. Please confirm the store name or take another photo.`,
            confidence: Math.max(...targetComparisons.map(/* Read destination-match confidences for the destination-not-found response. */ (item) => item.confidence), 0),
            sources: ["Google Street View imagery", "AI storefront recognition", "Google Maps place information"],
            comparisons: targetComparisons,
          });
          return;
        }

        res.status(200).json({
          code: "DESTINATION_CONFIRMATION_REQUIRED",
          requiresConfirmation: true,
          output:
            `The requested store was not found in the nearby Street View imagery. Based on Google Maps place information, the closest likely result is ${candidate.name}, located at ${candidate.address}, approximately ${candidate.estimatedBlocks} blocks (${candidate.walkingDistance}) away. Is this the store you are looking for?`,
          candidate,
          confidence: Math.max(...targetComparisons.map(/* Read destination-match confidences for a candidate that still requires user confirmation. */ (item) => item.confidence), 0),
          sources: ["Google Street View imagery", "AI storefront recognition", "Google Maps place information"],
          comparisons: targetComparisons,
        });
        return;
      }

      const turn = turnToClockPosition(currentView.angle, target.angle);
      const guidance = await this.generateGuidance(image, destination, turn.instruction);
      const uncertain = guidance.confidence < this.confidenceThreshold;

      const guidanceText = uncertain
        ? `Based on AI image comparison, this guidance is uncertain at ${guidance.confidence}% confidence. ${guidance.guidance} Please take another photo or confirm before relying on this instruction.`
        : `Based on the phone's GPS and compass data, ${turn.instruction} Based on AI image comparison, the storefront direction match is ${target.confidence}% confident. Based on AI recognition of your photo, ${guidance.guidance} (${guidance.confidence}% confidence).`;

      res.status(200).json({
        output: guidanceText,
        uncertain,
        confidenceThreshold: this.confidenceThreshold,
        currentView: {
          angle: currentView.angle,
          confidence: currentView.confidence,
          source: "AI image comparison against Google Street View imagery",
          comparisons: currentView.matches,
        },
        target: {
          name: destination,
          angle: target.angle,
          confidence: target.confidence,
          source: "AI storefront recognition against Google Street View imagery",
          comparisons: target.matches,
        },
        turn: {
          direction: turn.direction,
          degrees: turn.degrees,
          clockPosition: turn.clockPosition,
          source: "Phone GPS and compass data plus matched panorama angles",
        },
        guidance: {
          text: guidance.guidance,
          confidence: guidance.confidence,
          source: "AI recognition of the user's photo",
        },
        sources: [
          "Google Street View imagery",
          "Phone GPS and compass data",
          "AI image comparison",
          "AI storefront recognition",
        ],
      });
    } catch (error) {
      console.error("Last meters calculation failed:", error);
      res.status(500).json({ error: "Last meters calculation failed." });
    }
  }

  /**
   * Try the bounded legacy panorama download attempts and accept a tile set only when metadata,
   * payload sizes, and image dimensions are usable.
   */
  private async fetchValidatedPanoramaTiles(
    lat: number,
    lng: number,
  ): Promise<PanoramaTile[] | null> {
    const apiKey = googleMapsApiKey();
    if (!apiKey) return null;

    for (let attempt = 1; attempt <= PANORAMA_RETRY_COUNT; attempt += 1) {
      try {
        const metadataUrl = "https://maps.googleapis.com/maps/api/streetview/metadata";
        const metadataResponse = await axios.get<PanoramaMetadataResponse>(metadataUrl, {
          params: {
            location: `${lat},${lng}`,
            radius: 50,
            source: "outdoor",
            key: apiKey,
          },
          timeout: 10000,
        });

        const metadata = metadataResponse.data;
        if (outdoorPanoramaRejection(metadata)) {
          console.warn(`Street View metadata invalid on attempt ${attempt}:`, metadata.status);
          continue;
        }

        const tiles: PanoramaTile[] = [];
        let valid = true;

        for (const heading of HEADINGS) {
          const imageResponse = await axios.get<ArrayBuffer>(
            "https://maps.googleapis.com/maps/api/streetview",
            {
              params: {
                size: "640x640",
                pano: metadata.pano_id,
                heading,
                fov: LAST_MILE_PANORAMA_FOV_DEGREES,
                source: "outdoor",
                return_error_code: true,
                pitch: 0,
                key: apiKey,
              },
              responseType: "arraybuffer",
              timeout: 15000,
            },
          );

          const buffer = Buffer.from(imageResponse.data);
          const imageMetadata = await sharp(buffer).metadata();
          const usable =
            buffer.byteLength > 10000 &&
            (imageMetadata.width ?? 0) >= 320 &&
            (imageMetadata.height ?? 0) >= 320;

          if (!usable) {
            valid = false;
            console.warn(`Street View tile at ${heading}° was unusable on attempt ${attempt}.`);
            break;
          }

          tiles.push({
            heading,
            base64: `data:image/jpeg;base64,${buffer.toString("base64")}`,
          });
        }

        if (valid && tiles.length === HEADINGS.length) return tiles;
      } catch (error) {
        console.warn(`Street View panorama attempt ${attempt} failed:`, error);
      }
    }

    return null;
  }

  /**
   * Ask the model to compare the user photo against every labeled panorama view without forcing a
   * positive match.
   */
  private async compareCurrentPhotoToPanorama(
    image: string,
    tiles: PanoramaTile[],
  ): Promise<ComparisonResult[]> {
    const imageContent = this.panoramaMessageContent(tiles);
    imageContent.push({ type: "text", text: "USER PHOTO" });
    imageContent.push({ type: "image_url", image_url: { url: image } });

    return this.runComparison(
      `Compare the user's photo against every Street View image. Evaluate all ${HEADINGS.length} views, even after finding a match. For each view return whether it matches the user's current view, the view's labeled heading as matchedAngle, a confidence percentage from 0 to 100, and where the matching subject/view falls in that Street View image: left, center, right, or unknown. Do not invent a match when visual evidence is weak.`,
      imageContent,
    );
  }

  /**
   * Ask the model to check every panorama view for the named destination, reducing confidence when
   * identity is ambiguous.
   */
  private async findDestinationInPanorama(
    destination: string,
    tiles: PanoramaTile[],
  ): Promise<ComparisonResult[]> {
    return this.runComparison(
      `Inspect every Street View image for the storefront or store name "${destination}". Evaluate all ${HEADINGS.length} views, even after finding a match. For each view return whether the destination is present, the view's labeled heading as matchedAngle, a confidence percentage from 0 to 100, and whether the target is on the left, center, right, or unknown portion of the image. If signage or storefront identity is ambiguous, lower confidence and do not mark it as a confirmed match.`,
      this.panoramaMessageContent(tiles),
    );
  }

  /**
   * Request structured per-heading comparisons, normalize model values, and supply explicit
   * nonmatches for omitted views.
   */
  private async runComparison(
    instruction: string,
    content: Array<Record<string, unknown>>,
  ): Promise<ComparisonResult[]> {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `${instruction}\nReturn JSON only using this shape: {"comparisons":[{"heading":0,"match":true,"matchedAngle":0,"confidence":85,"position":"center"}]}. Include exactly one result for each heading ${HEADINGS.join(",")}.`,
        },
        { role: "user", content: content as never },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const parsed = this.parseJson<ComparisonEnvelope>(response.choices[0].message.content);
    const byHeading = new Map<number, ComparisonResult>();

    for (const raw of parsed?.comparisons ?? []) {
      const heading = Number(raw.heading);
      if (!HEADINGS.includes(heading as (typeof HEADINGS)[number])) continue;
      const position: TargetPosition =
        raw.position === "left" || raw.position === "center" || raw.position === "right"
          ? raw.position
          : "unknown";
      byHeading.set(heading, {
        heading,
        match: Boolean(raw.match),
        matchedAngle: Number.isFinite(Number(raw.matchedAngle)) ? normalizeHeading(Number(raw.matchedAngle)) : heading,
        confidence: clampConfidence(raw.confidence),
        position,
      });
    }

    return HEADINGS.map(
      /**
       * Return the normalized comparison for each expected heading, defaulting missing model
       * entries to zero-confidence nonmatches.
       */
      (heading) =>
        byHeading.get(heading) ?? {
          heading,
          match: false,
          matchedAngle: heading,
          confidence: 0,
          position: "unknown",
        },
    );
  }

  /**
   * Build alternating heading labels and image parts so model comparisons retain each tile's
   * direction.
   */
  private panoramaMessageContent(tiles: PanoramaTile[]): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [];
    for (const tile of tiles) {
      content.push({ type: "text", text: `STREET VIEW ${tile.heading}°` });
      content.push({ type: "image_url", image_url: { url: tile.base64 } });
    }
    return content;
  }

  /**
   * Look up a nearby destination candidate and walking-route distance for a confirmation-required
   * legacy response.
   */
  private async findPlaceCandidate(
    lat: number,
    lng: number,
    destination: string,
  ): Promise<PlaceCandidate | null> {
    const apiKey = googleMapsApiKey();
    if (!apiKey) return null;

    const placesResponse = await axios.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json", {
      params: {
        location: `${lat},${lng}`,
        rankby: "distance",
        keyword: destination,
        key: apiKey,
      },
      timeout: 10000,
    });

    const result = placesResponse.data?.results?.[0];
    if (!result?.place_id || !result?.name) return null;

    const directionsResponse = await axios.get("https://maps.googleapis.com/maps/api/directions/json", {
      params: {
        origin: `${lat},${lng}`,
        destination: `place_id:${result.place_id}`,
        mode: "walking",
        key: apiKey,
      },
      timeout: 10000,
    });

    const leg = directionsResponse.data?.routes?.[0]?.legs?.[0];
    const meters = Number(leg?.distance?.value) || 0;
    const walkingDistance = leg?.distance?.text || (meters > 0 ? `${meters} m` : "distance unavailable");
    const estimatedBlocks = meters > 0 ? Math.max(1, Math.round(meters / APPROX_METERS_PER_BLOCK)) : 0;

    return {
      name: result.name,
      address: result.vicinity || leg?.end_address || "address unavailable",
      placeId: result.place_id,
      walkingDistance,
      walkingDistanceMeters: meters,
      estimatedBlocks,
    };
  }

  /**
   * Ask the model for photo-grounded physical landmarks consistent with the computed direction,
   * preserving uncertainty instead of inventing a landmark.
   */
  private async generateGuidance(
    image: string,
    destination: string,
    turnInstruction: string,
  ): Promise<GuidanceResult> {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an orientation assistant for a Blind or Low Vision person. The destination is "${destination}". The system has calculated this direction: "${turnInstruction}". Use only the user's photo to describe useful physical or tactile landmarks that can help them orient safely. Do not contradict the calculated direction. Do not rely on elevated text signs. Return JSON only: {"guidance":"concise guidance","confidence":0}. Confidence must be an integer percentage from 0 to 100. If the image is unclear, lower confidence instead of inventing details.`,
        },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: image } }] as never,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const parsed = this.parseJson<GuidanceResult>(response.choices[0].message.content);
    return {
      guidance: parsed?.guidance?.trim() || "I cannot identify a reliable physical landmark in this photo.",
      confidence: clampConfidence(parsed?.confidence),
    };
  }

  /** Parse optional model JSON, returning null for empty or malformed content. */
  private parseJson<T>(content: string | null): T | null {
    if (!content) return null;
    try {
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
