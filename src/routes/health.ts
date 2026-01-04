import { Router } from 'express';

const router = Router();

// Health check endpoint
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Detailed health check
router.get('/ready', async (_req, res) => {
  try {
    // Add checks for external services here (Supabase, Stripe, etc.)
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: {
        api: 'ok',
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;

