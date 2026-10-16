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

    // Ensure all critical indexes on attendances collection are built
    try {
      const attCol = conn.connection.db?.collection('attendances');
      if (attCol) {
        await attCol.createIndex({ date: -1 }, { background: true });
        await attCol.createIndex({ userId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ userId: 1, date: -1 }, { background: true });
        await attCol.createIndex({ employeeId: 1, date: -1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, date: -1, loginTime: -1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, userId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, employeeId: 1, date: 1 }, { background: true });
        await attCol.createIndex({ organizationId: 1, date: 1, status: 1 }, { background: true });
        await attCol.createIndex({ loginTime: -1 }, { background: true });
        logger.info('⚡ Attendance collection indexes verified and ensured.');
      }
    } catch (idxErr: any) {
      logger.warn('Index initialization note:', idxErr.message);
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
