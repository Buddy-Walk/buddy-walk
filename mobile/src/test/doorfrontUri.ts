// services/doorfront.ts reads DOORFRONT_URI once, when it loads, and cannot build its Mongo client
// without one. Import this before any server module so tests can fake that client at the driver.
// Nothing connects: tests that reach Doorfront fake MongoClient.prototype.connect and db.
process.env.DOORFRONT_URI = "mongodb://doorfront.test";
