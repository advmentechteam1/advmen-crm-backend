import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import 'express-async-errors';

import { env } from './config/env.js';
import { contextMiddleware } from './middleware/context.middleware.js';
import { requestIdMiddleware } from './middleware/requestId.middleware.js';
import { rateLimiterMiddleware } from './middleware/rateLimiter.middleware.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.middleware.js';
import { healthRouter } from './routes/health.routes.js';
import { apiRouter } from './routes/index.js';
import { AppError } from './shared/errors/AppError.js';

export function createApp(): Express {
  const app: Express = express();

  // 1. Core Security & Request Parsing Middlewares
  // Allow cross-origin <img> loading (frontend on a different port/domain loads selfie images from this API)
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);

        // Allow configured client URLs (supports comma-separated list)
        const allowedOrigins = (env.CLIENT_URL || '')
          .split(',')
          .map((url) => url.trim().replace(/\/$/, ''))
          .filter(Boolean);

        const normalizedOrigin = origin.replace(/\/$/, '');

        if (
          allowedOrigins.includes(normalizedOrigin) ||
          normalizedOrigin === 'http://localhost:3000' ||
          normalizedOrigin === 'http://localhost:5173' ||
          normalizedOrigin.endsWith('.vercel.app')
        ) {
          return callback(null, true);
        }

        // In non-production environments, dynamically permit local IP subnets (for mobile & LAN testing)
        if (env.NODE_ENV !== 'production') {
          const isLocalNetwork = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
            origin
          );
          if (isLocalNetwork) {
            return callback(null, true);
          }
        }

        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Target-Organization-Id'],
    })
  );

  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  // 2. Correlation Tracking & Throttling
  app.use(contextMiddleware);
  app.use(requestIdMiddleware);
  app.use(rateLimiterMiddleware);

  // 3. Health check probes (unversioned, unthrottled for orchestrators)
  app.use('/health', healthRouter);

  // 4. Root Service Info / Ping Handler
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      message: 'ADVMEN SalesOS API Server is running',
      version: 'v1.0.0',
      health: '/health/live',
      api: '/api/v1',
    });
  });

  // Handle browser favicon ping without error logs
  app.get('/favicon.ico', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  // 5. API v1 Router Mount
  app.use('/api/v1', apiRouter);

  // 5. 404 Fallback for Unmatched Routes
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(AppError.notFound(`Endpoint ${req.method} ${req.originalUrl}`));
  });

  // 6. Global Exception & Error Boundary Middleware
  app.use(errorHandlerMiddleware);

  return app;
}
