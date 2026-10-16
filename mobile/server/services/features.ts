import { treeInterface, TreeModel, sidewalkMaterialInterface, pedestrianRampInterface, SidewalkMaterialModel, PedestrianRampModel } from "../database/models/features";

/**
 * Query nearby trees, sidewalk materials, and pedestrian ramps within the radius in miles,
 * returning the available feature collections.
 */
export async function getNearbyFeatures(latitude: number, longitude: number, radius: number = 0.5) {
    console.log("Fetching nearby features for coordinates:", latitude, longitude);
    let features = {
        trees: [] as treeInterface[],
        sidewalkMaterials: [] as sidewalkMaterialInterface[],
        pedestrianRamps: [] as pedestrianRampInterface[]
    }
    try {
        const trees = await TreeModel.find({
            location: {
                $geoWithin: {
                    $centerSphere: [[longitude, latitude], radius / 3963.2] // ~0.5 mile radius
                }
            }
        }, { _id: 0, location: 1 }); // Only return location field

        console.log("Trees found:", trees.length);
        features.trees = trees;


        const sidewalkMaterials = await SidewalkMaterialModel.find({
            location: {
                $geoWithin: {
                    $centerSphere: [[longitude, latitude], radius / 3963.2] // ~0.5 mile radius
                }
            }
        }, { _id: 0, location: 1, material: 1 }); // Only return location and material fields
        features.sidewalkMaterials = sidewalkMaterials;
        console.log("Sidewalk materials found:", sidewalkMaterials.length);

        const pedestrianRamps = await PedestrianRampModel.find({
            location: {
                $geoWithin: {
                    $centerSphere: [[longitude, latitude], radius / 3963.2] // ~0.5 mile radius
                }
            }
        }, { _id: 0, location: 1 }); // Only return location field
        features.pedestrianRamps = pedestrianRamps;
        console.log("Pedestrian ramps found:", pedestrianRamps.length);

        return features;
    } catch (error) {
        console.error("Error fetching features:", error);
        throw new Error("Failed to fetch features");
    }
}

