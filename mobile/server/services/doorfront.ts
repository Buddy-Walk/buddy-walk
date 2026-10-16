import { MongoClient, ObjectId } from 'mongodb';
import { AppContext } from '../types/index';
import dotenv from 'dotenv';
dotenv.config();

const doorfront_uri = process.env.DOORFRONT_URI;
const dbName = 'myFirstDatabase';
const collectionName = 'collect_panorama';

/** Escape user address text before embedding it in a Mongo regular-expression lookup. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let clientPromise: Promise<MongoClient> | null = null;

/**
 * Reuse one Doorfront Mongo connection attempt and clear a failed attempt so a later lookup can
 * reconnect.
 */
async function connectToDoorfrontDB() {
  try {
    if (!clientPromise) {
      clientPromise = (async () => {
        // Initialize the shared Doorfront client with a bounded connection pool.
        const c = new MongoClient(doorfront_uri!, { maxPoolSize: 10 });
        await c.connect();
        console.log('Connected to Doorfront database');
        return c;
      })();
    }
    const c = await clientPromise;
    return c.db(dbName);
  } catch (error) {
    clientPromise = null;
    console.error('Error connecting to Doorfront database:', error);
  }
}

/**
 * Look up Doorfront imagery and its first human label by a case-insensitive literal address,
 * returning null when unavailable.
 */
export async function getPanoramaData(ctx: AppContext, address: string) {
    const { res } = ctx;
  try {
    const db = await connectToDoorfrontDB();
    if (db && address && address.trim() !== '') {
        const collection = db.collection(collectionName);
        const data = await collection.findOne(
            { address: { $regex: escapeRegex(address), $options: 'i' } }, 
            { projection: {url:1, human_labels:{$slice:1}, creator:1,address:1, location: 1, image_description:1 }})
        if (data) { 
            console.log("Panorama data fetched successfully for address:", address);
            console.log("Image URL: ", data.url);
            // res.status(200).json(data);
            return data; 
        }
        else return null;
        // res.status(404).json({ message: 'No panorama data found for this address.' });
    } else {
        // res.status(500).json({ message: 'Database connection failed or invalid address.' });
        console.error('Database connection failed or invalid address');
        return null;
    }
  } catch (error) {
    console.error('Error fetching panorama data:', error);
    return null;
  }
}

/**
 * Set a panorama's generated description and update time, returning false for missing records or
 * failed writes.
 */
export async function addPanoramaDescription(panoramaId: string, description: string) {
  try {
    const db = await connectToDoorfrontDB();
    if (!db) {
      throw new Error("Failed to connect to database");
    }

    const collection = db.collection(collectionName);

    // Using $set will add the field if it doesn't exist, 
    // or overwrite it if it already does.
    const result = await collection.updateOne(
      { _id: new ObjectId(panoramaId) },
      { 
        $set: { 
          image_description: description,
          updatedAt: new Date() // Good practice to track when the write happened
        } 
      }
    );

    if (result.matchedCount === 0) {
      console.warn(`No panorama found with ID: ${panoramaId}`);
      return false;
    }

    console.log(`Successfully updated panorama ${panoramaId} with description.`);
    return true;

  } catch (error) {
    console.error('Error adding text description:', error);
    return false;
  }
}