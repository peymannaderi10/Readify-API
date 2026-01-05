import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getUsageStats, getUsageHistory, recordTokenUsage, getCurrentLimits } from '../lib/token-tracker.js';
import { isPremiumUser } from '../lib/supabase.js';
import { apiRateLimiter } from '../middleware/rate-limit.js';

const router = Router();

// ============================================
// GET /usage/stats - Get user's per-feature token usage stats
// ============================================
router.get('/stats', apiRateLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const isPremium = await isPremiumUser(userId);
    const stats = await getUsageStats(userId, isPremium);
    
    // Return per-feature stats
    res.json({
      success: true,
      tier: stats.tier,
      chat: {
        used: stats.chat.used,
        limit: stats.chat.limit,
        remaining: stats.chat.remaining,
        percentUsed: stats.chat.percentUsed,
        isWarning: stats.chat.isWarning,
        allowed: stats.chat.allowed,
      },
      tts: {
        used: stats.tts.used,
        limit: stats.tts.limit,
        remaining: stats.tts.remaining,
        percentUsed: stats.tts.percentUsed,
        isWarning: stats.tts.isWarning,
        allowed: stats.tts.allowed,
      },
      realtime: {
        used: stats.realtime.used,
        limit: stats.realtime.limit,
        remaining: stats.realtime.remaining,
        percentUsed: stats.realtime.percentUsed,
        isWarning: stats.realtime.isWarning,
        allowed: stats.realtime.allowed,
      },
      resetDate: stats.resetDate,
      // Also include limits info for UI display
      limits: await getCurrentLimits().then(l => isPremium ? l.premium : l.free),
    });
  } catch (error) {
    console.error('Usage stats error:', error);
    res.status(500).json({
      error: 'Failed to get usage stats',
      code: 'USAGE_ERROR',
    });
  }
});

// ============================================
// GET /usage/history - Get detailed usage history
// ============================================
router.get('/history', apiRateLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const days = parseInt(req.query.days as string) || 30;
    
    // Limit days to reasonable range
    const validDays = Math.min(Math.max(days, 1), 90);
    
    const history = await getUsageHistory(userId, validDays);
    
    // Group history by endpoint for easier display
    const grouped = {
      chat: history.filter(h => h.endpoint === 'chat'),
      tts: history.filter(h => h.endpoint === 'tts'),
      realtime: history.filter(h => h.endpoint === 'realtime'),
    };
    
    res.json({
      success: true,
      history,
      grouped,
      days: validDays,
    });
  } catch (error) {
    console.error('Usage history error:', error);
    res.status(500).json({
      error: 'Failed to get usage history',
      code: 'USAGE_HISTORY_ERROR',
    });
  }
});

// ============================================
// GET /usage/limits - Get current tier limits (no auth required for display)
// ============================================
router.get('/limits', apiRateLimiter, async (_req: Request, res: Response): Promise<void> => {
  try {
    const limits = await getCurrentLimits();
    res.json({
      success: true,
      free: limits.free,
      premium: limits.premium,
    });
  } catch (error) {
    console.error('Get limits error:', error);
    res.status(500).json({
      error: 'Failed to get limits',
      code: 'LIMITS_ERROR',
    });
  }
});

// ============================================
// POST /usage/record-realtime - Record realtime session usage
// Called by client after voice session ends
// ============================================
const recordRealtimeSchema = z.object({
  tokensUsed: z.number().min(0).max(1000000),
  endpoint: z.enum(['realtime']),
}).strict();

router.post('/record-realtime', apiRateLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = recordRealtimeSchema.parse(req.body);
    const userId = req.user!.id;
    
    // Only record if there's actual usage
    if (body.tokensUsed > 0) {
      await recordTokenUsage({
        userId,
        tokensUsed: body.tokensUsed,
        model: 'gpt-4o-realtime',
        endpoint: 'realtime',
      });
      
      console.log(`[Usage] Recorded realtime session: ${body.tokensUsed} tokens for user ${userId}`);
    }
    
    res.json({
      success: true,
      recorded: body.tokensUsed,
    });
  } catch (error) {
    console.error('Record realtime usage error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid request',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to record usage',
      code: 'USAGE_RECORD_ERROR',
    });
  }
});

export default router;

