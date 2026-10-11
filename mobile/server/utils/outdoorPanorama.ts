export interface OutdoorPanoramaMetadata {
  status: string;
  pano_id?: string;
  copyright?: string;
  location?: { lat: number; lng: number };
}

// Only use with metadata retrieved with source=outdoor. Copyright alone
// cannot establish whether imagery was captured indoors or outdoors.
export function outdoorPanoramaRejection(metadata: OutdoorPanoramaMetadata): string | null {
  if (metadata.status !== "OK") return metadata.status || "INVALID_METADATA";
  if (!metadata.pano_id?.trim() || !metadata.location ||
      !Number.isFinite(metadata.location.lat) || Math.abs(metadata.location.lat) > 90 ||
      !Number.isFinite(metadata.location.lng) || Math.abs(metadata.location.lng) > 180) {
    return "INVALID_METADATA";
  }
  if (!/\bGoogle\b/i.test(metadata.copyright ?? "")) return "NON_GOOGLE_PANORAMA";
  return null;
}
