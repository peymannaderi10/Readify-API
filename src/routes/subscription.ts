import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSubscriptionDetails } from '../lib/supabase.js';

const router = Router();

// ============================================
// GET /subscription/status - Check user's subscription status
// ============================================
router.get('/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    
    const subscription = await getSubscriptionDetails(userId);
    
    res.json({
      success: true,
      ...subscription,
    });
    
  } catch (error) {
    console.error('Subscription status error:', error);
    res.status(500).json({
      error: 'Failed to get subscription status',
      code: 'SUBSCRIPTION_ERROR',
    });
  }
});

export default router;

