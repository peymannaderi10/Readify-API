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
import aiRoutes from './routes/ai.js';
import subscriptionRoutes from './routes/subscription.js';

export function createApp() {
  const app: Express = express();

  // Trust proxy for Render/production
  app.set('trust proxy', 1);

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Disable for API
  }));

  // CORS configuration
  // Note: For Chrome extensions, content scripts run in the web page context,
  // so the Origin header is the page's origin (e.g., wikipedia.org), not the extension.
  // Security is enforced via JWT authentication, not CORS origin checking.
  const corsOptions = {
    origin: true, // Allow all origins - security is handled by JWT auth on protected routes
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
  app.use('/api/ai', aiRoutes);
  app.use('/api/subscription', subscriptionRoutes);

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

let started = false;

export function startServer() {
  // Prevent double-start with tsx watch/hot reload
  if (started) {
    console.log('⚠️ Server already started, skipping...');
    return;
  }
  started = true;

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

