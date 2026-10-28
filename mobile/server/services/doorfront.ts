import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const doorfront_uri = process.env.DOORFRONT_URI;
const dbName = 'myFirstDatabase';
const collectionName = 'collect_panorama';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let clientPromise: Promise<MongoClient> | null = null;

async function connectToDoorfrontDB() {
  try {
    if (!clientPromise) {
      clientPromise = (async () => {
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

export async function getPanoramaData(address: string) {
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
            return data; 
        }
        else return null;
    } else {
        console.error('Database connection failed or invalid address');
        return null;
    }
  } catch (error) {
    console.error('Error fetching panorama data:', error);
    return null;
  }
}

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