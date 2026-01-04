import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { env, isDev } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { setupWebSocket } from './websocket/handler.js';

// Import routes
import healthRoutes from './routes/health.js';
import stripeRoutes from './routes/stripe.js';
import sitesRoutes from './routes/sites.js';

export function createApp() {
  const app: Express = express();

  // Trust proxy for Render/production
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Disable for API
  }));

  // CORS configuration
  const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (like mobile apps, curl, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Allow Chrome extension origins
      if (origin.startsWith('chrome-extension://')) {
        callback(null, true);
        return;
      }

      // Allow specific frontend URLs
      if (env.FRONTEND_URL && origin === env.FRONTEND_URL) {
        callback(null, true);
        return;
      }

      // Allow localhost in development
      if (isDev && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
        callback(null, true);
        return;
      }

      // Block other origins
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  };
  app.use(cors(corsOptions));

  // Body parsing - except for Stripe webhook which needs raw body
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/stripe/webhook') {
      // Use raw body for Stripe webhook signature verification
      express.raw({ type: 'application/json' })(req, res, next);
    } else {
      express.json({ limit: '10mb' })(req, res, next);
    }
  });

  // Request logging in development
  if (isDev) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }

  // API routes
  app.use('/health', healthRoutes);
  app.use('/api/stripe', stripeRoutes);
  app.use('/api/sites', sitesRoutes);

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Readify API',
      version: '1.0.0',
      status: 'running',
      docs: '/health',
    });
  });

  // 404 handler
  app.use(notFoundHandler);

  // Error handler
  app.use(errorHandler);

  return app;
}

export function startServer() {
  const app = createApp();
  const server = createServer(app);

  // Setup WebSocket server
  setupWebSocket(server);

  const port = parseInt(env.PORT, 10);

  server.listen(port, () => {
    console.log(`
🚀 Readify API Server
━━━━━━━━━━━━━━━━━━━━━
📡 HTTP:      http://localhost:${port}
🔌 WebSocket: ws://localhost:${port}/ws
🌍 Environment: ${env.NODE_ENV}
━━━━━━━━━━━━━━━━━━━━━
    `);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}

