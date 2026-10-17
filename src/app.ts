import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';

const prisma = new PrismaClient();

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: '*', // Allow development frontend origins
      credentials: true,
    })
  );

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ limit: '25mb', extended: true }));

  // Health check with real database connection verification
  const healthCheck = async (req: express.Request, res: express.Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[Database Connection Probe Failed]:', err.message);
      res.status(503).json({
        status: 'error',
        database: 'disconnected',
        error: err.message || 'Database unreachable',
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get('/health', healthCheck);
  app.get('/api/health', healthCheck);

  // Main API
  app.use('/api', routes);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
