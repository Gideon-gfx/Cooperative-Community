import { MongoClient, type Db } from 'mongodb';

let client: MongoClient | undefined;
let dbPromise: Promise<Db> | undefined;

export function getMongoDb(): Promise<Db> {
  if (!dbPromise) {
    const uri = process.env.DATABASE_URL;
    if (!uri) throw new Error('DATABASE_URL is required to connect to MongoDB');
    const connection = new MongoClient(uri);
    client = connection;
    dbPromise = client.connect().then(
      (connectedClient) => connectedClient.db(),
      (error: unknown) => {
        if (client === connection) client = undefined;
        dbPromise = undefined;
        throw error;
      },
    );
  }
  return dbPromise;
}

export async function closeMongoConnection(): Promise<void> {
  if (client) await client.close();
  client = undefined;
  dbPromise = undefined;
}
