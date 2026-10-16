import http from 'http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { initSocketIO } from './config/socket.js';
import { seedDatabase } from './config/seed.js';
import { logger } from './shared/logger/logger.js';

async function bootstrap() {
  // 1. Establish Database Connection
  await connectDB();

  // 2. Automatically Seed Production & Demo Initial Records
  await seedDatabase().catch((err) => logger.warn('⚠️ Seeding note:', err.message));

  // 2.1 Clean up duplicate attendance records in background
  import('./modules/attendance/attendance.service.js')
    .then(({ attendanceService }) => attendanceService.deduplicateAttendanceRecords())
    .catch((err) => logger.warn('Attendance deduplication init note:', err.message));

  // 3. Initialize Express Application & HTTP Server
  const app = createApp();
  const server = http.createServer(app);

  // 3. Initialize Real-Time WebSockets
  initSocketIO(server);

  // 4. Handle Server Listen Errors & Start Listening
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`❌ Port ${env.PORT} is already in use by another running process.`);
      logger.error(`👉 To free port ${env.PORT}, run: npx kill-port ${env.PORT} or stop existing running instances.`);
      process.exit(1);
    } else {
      logger.error('❌ Server startup error:', err);
      process.exit(1);
    }
  });

  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`🚀 ${env.APP_NAME} Backend running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`🔗 Health Check: http://localhost:${env.PORT}/health/live`);
    logger.info(`🔗 API v1 Base: http://localhost:${env.PORT}/api/v1`);
  });

  // 5. Graceful Process Termination Handlers
  const gracefulShutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal}. Starting graceful shutdown...`);

    server.close(async () => {
      logger.info('🛑 HTTP server closed.');
      await disconnectDB();
      logger.info('👋 Graceful shutdown complete. Process exiting.');
      process.exit(0);
    });

    // Force shutdown after 10 seconds if hanging
    setTimeout(() => {
      logger.error('⚠️ Forcefully terminating process due to shutdown timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('❌ Unhandled Promise Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error('❌ Uncaught Exception:', err);
    // In production, supervise process restart
  });
}

bootstrap().catch((err) => {
  logger.error('❌ Fatal Server Startup Error:', err);
  process.exit(1);
});
