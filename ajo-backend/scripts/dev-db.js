// Local MongoDB for development: a single-node replica set (rs0) on :27017 that keeps its data in .mongo-data/.
// Prisma needs a replica set for transactions. Run `npm run db` in its own terminal and leave it open.
const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const dbPath = path.join(__dirname, '..', '.mongo-data');
fs.mkdirSync(dbPath, { recursive: true });

(async () => {
  const rs = await MongoMemoryReplSet.create({
    binary: { version: '6.0.14' },
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger', dbName: 'ajo' },
    instanceOpts: [{ port: 27017, dbPath, storageEngine: 'wiredTiger', launchTimeout: 60000 }],
  });
  console.log(`MongoDB ready: mongodb://localhost:27017/ajo?replicaSet=rs0  (data in ${dbPath})`);
  const stop = async () => { await rs.stop({ doCleanup: false }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
