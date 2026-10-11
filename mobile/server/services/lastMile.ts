import axios from "axios";
import OpenAI from "openai";
import { AppContext } from "../types";

const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
const DEFAULT_CONFIDENCE_THRESHOLD = 70;
const APPROX_METERS_PER_BLOCK = 80;

type TargetPosition = "left" | "center" | "right" | "unknown";

interface PanoramaTile {
  heading: number;
  base64: string;
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

function clampConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

function circularDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(diff, 360 - diff);
}

function circularAverage(a: number, b: number): number {
  const first = normalizeHeading(a);
  const second = normalizeHeading(b);
  const diff = ((second - first + 540) % 360) - 180;
  return normalizeHeading(first + diff / 2);
}

function positionOffset(position: TargetPosition): number {
  if (position === "left") return -15;
  if (position === "right") return 15;
  return 0;
}

function selectBestAngle(
  comparisons: ComparisonResult[],
  confidenceThreshold: number,
): { angle: number; confidence: number; matches: ComparisonResult[] } | null {
  const matches = comparisons
    .filter((item) => item.match && item.confidence >= confidenceThreshold)
    .sort((a, b) => b.confidence - a.confidence);

  if (matches.length === 0) return null;

  const best = matches[0];
  let angle = normalizeHeading(best.matchedAngle + positionOffset(best.position));

  const adjacent = matches.find(
    (candidate, index) => index > 0 && circularDistance(best.matchedAngle, candidate.matchedAngle) === 45,
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

function googleMapsApiKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
}

export class LastMileService {
  private readonly client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  private get confidenceThreshold(): number {
    const configured = Number(process.env.AI_CONFIDENCE_THRESHOLD);
    if (!Number.isFinite(configured)) return DEFAULT_CONFIDENCE_THRESHOLD;
    return Math.max(0, Math.min(100, configured));
  }

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
            "Last Meters uses Google Places, GPS, and compass only. This older panorama matcher is no longer used.",
          sources: ["Google Maps"],
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
            "Based on AI image comparison, I am not confident enough to determine which photo direction matches your photo. Please take another photo from your current position.",
          confidence: Math.max(...currentViewComparisons.map((item) => item.confidence), 0),
          sources: ["AI image comparison", "Google Maps"],
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
              `Based on Google Maps and AI storefront recognition, I could not identify ${destination} nearby. I also could not find a relevant Google Places result. Please confirm the store name or take another photo.`,
            confidence: Math.max(...targetComparisons.map((item) => item.confidence), 0),
            sources: ["Google Maps", "AI storefront recognition", "Google Maps place information"],
            comparisons: targetComparisons,
          });
          return;
        }

        res.status(200).json({
          code: "DESTINATION_CONFIRMATION_REQUIRED",
          requiresConfirmation: true,
          output:
            `The requested store was not found in the nearby photo imagery. Based on Google Maps place information, the closest likely result is ${candidate.name}, located at ${candidate.address}, approximately ${candidate.estimatedBlocks} blocks (${candidate.walkingDistance}) away. Is this the store you are looking for?`,
          candidate,
          confidence: Math.max(...targetComparisons.map((item) => item.confidence), 0),
          sources: ["Google Maps", "AI storefront recognition", "Google Maps place information"],
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
          source: "AI image comparison against Google Maps",
          comparisons: currentView.matches,
        },
        target: {
          name: destination,
          angle: target.angle,
          confidence: target.confidence,
          source: "AI storefront recognition against Google Maps",
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
          "Google Maps",
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

  private async fetchValidatedPanoramaTiles(
    _lat: number,
    _lng: number,
  ): Promise<PanoramaTile[] | null> {
    return null;
  }

  private async compareCurrentPhotoToPanorama(
    image: string,
    tiles: PanoramaTile[],
  ): Promise<ComparisonResult[]> {
    const imageContent = this.panoramaMessageContent(tiles);
    imageContent.push({ type: "text", text: "USER PHOTO" });
    imageContent.push({ type: "image_url", image_url: { url: image } });

    return this.runComparison(
      `Compare the user's photo against every photo image. Evaluate all eight views, even after finding a match. For each view return whether it matches the user's current view, the view's labeled heading as matchedAngle, a confidence percentage from 0 to 100, and where the matching subject/view falls in that photo image: left, center, right, or unknown. Do not invent a match when visual evidence is weak.`,
      imageContent,
    );
  }

  private async findDestinationInPanorama(
    destination: string,
    tiles: PanoramaTile[],
  ): Promise<ComparisonResult[]> {
    return this.runComparison(
      `Inspect every photo image for the storefront or store name "${destination}". Evaluate all eight views, even after finding a match. For each view return whether the destination is present, the view's labeled heading as matchedAngle, a confidence percentage from 0 to 100, and whether the target is on the left, center, right, or unknown portion of the image. If signage or storefront identity is ambiguous, lower confidence and do not mark it as a confirmed match.`,
      this.panoramaMessageContent(tiles),
    );
  }

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
            `${instruction}\nReturn JSON only using this shape: {"comparisons":[{"heading":0,"match":true,"matchedAngle":0,"confidence":85,"position":"center"}]}. Include exactly one result for each heading 0,45,90,135,180,225,270,315.`,
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

  private panoramaMessageContent(tiles: PanoramaTile[]): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [];
    for (const tile of tiles) {
      content.push({ type: "text", text: `VIEW ${tile.heading}°` });
      content.push({ type: "image_url", image_url: { url: tile.base64 } });
    }
    return content;
  }

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

  private parseJson<T>(content: string | null): T | null {
    if (!content) return null;
    try {
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
