import axios from "axios";
import { outdoorPanoramaRejection } from "../utils/outdoorPanorama";

export function getGoogleMapsApiKey(): string {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Google Maps API key is not configured on the server.");
  }
  return apiKey;
}

export async function geocodeCoordinates(latitude: number, longitude: number) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${getGoogleMapsApiKey()}`;
  try {
    const response = await axios.get(url);
    return response.data.results;
  } catch (error) {
    console.error("Error fetching nearby places:", error);
    throw error;
  }
}

// streetview-heading.ts

// --- 1. Type Definitions ---

export interface LatLng {
  lat: number;
  lng: number;
}

interface GeocodeResponse {
  status: string;
  results: {
    geometry: {
      location: LatLng;
    };
  }[];
}

interface StreetViewMetadataResponse {
  status: string;
  pano_id?: string;
  copyright?: string;
  location?: LatLng; // 'location' is the car's position
}

// --- 3. The Math Helper ---
export function calculateHeading(from: LatLng, to: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const toDeg = (rad: number): number => (rad * 180) / Math.PI;

  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const deltaLambda = toRad(to.lng - from.lng);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  const heading = toDeg(theta);

  // Normalize to 0-360
  return (heading + 360) % 360;
}

// --- 4. Main Logic ---
export async function getStreetViewWithHeading(
  address: string,
): Promise<string | null> {
  try {
    console.log(`\n1. Geocoding address: "${address}"...`);

    // Step A: Geocode Address (Find the House)
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address,
    )}&key=${getGoogleMapsApiKey()}`;

    const geoRes = await fetch(geoUrl);
    const geoData = (await geoRes.json()) as GeocodeResponse;

    if (geoData.status !== "OK" || !geoData.results.length) {
      throw new Error(`Geocoding failed: ${geoData.status}`);
    }

    const houseLoc: LatLng = geoData.results[0].geometry.location;
    console.log(`   House found at: ${houseLoc.lat}, ${houseLoc.lng}`);

    // Step B: Find Nearest Panorama (Find the Car)
    // The Metadata API returns the specific lat/lng where the car was standing
    const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${houseLoc.lat},${houseLoc.lng}&source=outdoor&key=${getGoogleMapsApiKey()}`;

    const metaRes = await fetch(metaUrl);
    const metaData = (await metaRes.json()) as StreetViewMetadataResponse;

    if (outdoorPanoramaRejection(metaData) || !metaData.location) {
      throw new Error(`No Street View found nearby: ${metaData.status}`);
    }

    const carLoc: LatLng = metaData.location;
    console.log(`   Car found at:   ${carLoc.lat}, ${carLoc.lng}`);

    // Step C: Calculate Heading
    const heading = calculateHeading(carLoc, houseLoc);
    console.log(`   Calculated Heading: ${heading.toFixed(2)}°`);

    // Step D: Construct Final URL
    const finalUrl = `https://maps.googleapis.com/maps/api/streetview?size=640x480&pano=${encodeURIComponent(metaData.pano_id!)}&heading=${heading.toFixed(2)}&fov=80&pitch=0&source=outdoor&return_error_code=true&key=${getGoogleMapsApiKey()}`;

    console.log("Outdoor Street View reference ready.");
    return finalUrl;
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    } else {
      console.error("An unknown error occurred");
    }
    return null;
  }
}
