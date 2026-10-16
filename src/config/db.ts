import mongoose, { ConnectOptions } from 'mongoose';
import { env } from './env.js';
import { logger } from '../shared/logger/logger.js';

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) {
    return;
  }

  const isAtlas = env.MONGODB_URI.startsWith('mongodb+srv://');

  const mongooseOptions: ConnectOptions = {
    autoIndex: true, // Create compound indexes on boot
    serverSelectionTimeoutMS: 15000, // 15s timeout for Atlas cluster discovery
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
    w: 'majority',
  };

  try {
    const conn = await mongoose.connect(env.MONGODB_URI, mongooseOptions);

    isConnected = true;
    const dbType = isAtlas ? 'MongoDB Atlas Cluster' : 'MongoDB';
    logger.info(`✅ ${dbType} Connected Successfully: ${conn.connection.host}/${conn.connection.name}`);

    // Ensure 'attendances' is our sole attendance collection (never drop 'attendances'!)
    try {
      const db = conn.connection.db;
      if (db) {
        const collections = await db.listCollections().toArray();
        const hasLegacySingular = collections.some((c) => c.name === 'attendance');

        // If legacy singular 'attendance' collection exists, merge docs into 'attendances'
        if (hasLegacySingular) {
          logger.info('🔄 Checking if legacy "attendance" collection has records to merge into "attendances"...');
          const legacyCol = db.collection('attendance');
          const attendancesCol = db.collection('attendances');

          const legacyDocs = await legacyCol.find({}).toArray();
          if (legacyDocs.length > 0) {
            const bulkOps = legacyDocs.map((doc) => ({
              updateOne: {
                filter: { _id: doc._id },
                update: { $setOnInsert: doc },
                upsert: true,
              },
            }));
            await attendancesCol.bulkWrite(bulkOps, { ordered: false });
            logger.info(`✅ Merged ${legacyDocs.length} records into single "attendances" collection.`);
          }

          // Clean up legacy singular collection
          try {
            await legacyCol.drop();
            logger.info('🗑️ Successfully removed legacy "attendance" collection. Only "attendances" remains.');
          } catch (dropErr: any) {
            logger.warn('Could not drop legacy attendance collection:', dropErr.message);
          }
        }

        // Build indexes on the single 'attendances' collection
        const attCol = db.collection('attendances');
        await attCol.createIndex({ date: -1 }, { background: true });
        await attCol.createIndex({ userId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ userId: 1, date: -1 }, { background: true });
        await attCol.createIndex({ employeeId: 1, date: -1 }, { background: true });
        await attCol.createIndex({ empId: 1, date: -1 }, { background: true });
        await attCol.createIndex({ empName: 1 }, { background: true });
        await attCol.createIndex({ userName: 1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, date: -1, loginTime: -1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, userId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, employeeId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, date: 1, status: 1 }, { background: true });
        await attCol.createIndex({ loginTime: -1 }, { background: true });
        await attCol.createIndex({ punchIn: -1 }, { background: true });
        logger.info('⚡ Single unified "attendances" collection indexes verified.');
      }
    } catch (idxErr: any) {
      logger.warn('Attendance collection setup note:', idxErr.message);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const dbType = isAtlas ? 'MongoDB Atlas' : 'MongoDB';
    logger.error(`❌ ${dbType} Connection Error: ${errorMsg}`, error);

    if (isAtlas && (errorMsg.includes('whitelist') || errorMsg.includes('querySrv ETIMEOUT') || errorMsg.includes('ENOTFOUND') || errorMsg.includes('bad auth'))) {
      console.warn('💡 [MongoDB Atlas Tip]: Please ensure:');
      console.warn('   1. Your current IP address is added to MongoDB Atlas Network Access whitelist (0.0.0.0/0 or Current IP).');
      console.warn('   2. Database username and password in MONGODB_URI are URL-encoded if containing special characters.');
    }

    if (env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('⚠️ MongoDB Atlas Disconnected. Attempting auto-reconnection...');
  });

  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logger.info('🔄 MongoDB Atlas Reconnected Successfully');
  });

  mongoose.connection.on('error', (err) => {
    logger.error('❌ MongoDB Atlas Runtime Error:', err);
  });
}

export function isDBConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function disconnectDB(): Promise<void> {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('🛑 MongoDB Atlas Disconnected cleanly.');
  }
}
