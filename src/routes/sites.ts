import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

const router = Router();

const FREE_SITE_LIMIT = 5;

// ============================================
// POST /sites/save
// ============================================
const saveSiteSchema = z.object({
  url_digest: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  hostname: z.string().optional(),
  changes: z.array(z.any()).optional(),
  notes: z.record(z.any()).optional(),
});

router.post('/save', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = saveSiteSchema.parse(req.body);
    const user = req.user!;

    // Check if user can add this site (server-side limit enforcement)
    const { data: limitCheck, error: limitError } = await supabaseAdmin
      .rpc('can_add_site', { user_uuid: user.id, site_url_digest: body.url_digest });

    if (limitError) {
      console.error('Limit check error:', limitError);
      throw new AppError('Failed to check site limits', 500, 'LIMIT_CHECK_FAILED');
    }

    // If user can't add (hit free limit)
    if (!limitCheck.can_add) {
      res.status(403).json({
        error: 'Website limit reached',
        code: 'LIMIT_REACHED',
        reason: limitCheck.reason,
        site_count: limitCheck.site_count,
        max_sites: limitCheck.max_sites || FREE_SITE_LIMIT,
        is_premium: limitCheck.is_premium,
      });
      return;
    }

    // Upsert the site data
    const { data, error } = await supabaseAdmin
      .from('user_sites')
      .upsert({
        user_id: user.id,
        url_digest: body.url_digest,
        url: body.url || '',
        title: body.title || '',
        hostname: body.hostname || '',
        changes: body.changes || [],
        notes: body.notes || {},
        last_modified: new Date().toISOString(),
      }, {
        onConflict: 'user_id,url_digest',
      })
      .select()
      .single();

    if (error) {
      console.error('Upsert error:', error);
      throw new AppError('Failed to save site data', 500, 'SAVE_FAILED');
    }

    res.json({
      success: true,
      data,
      site_count: limitCheck.site_count + (limitCheck.is_existing_site ? 0 : 1),
      is_premium: limitCheck.is_premium,
    });
  } catch (error) {
    console.error('Save site error:', error);
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// GET /sites/list
// ============================================
router.get('/list', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    const { data, error } = await supabaseAdmin
      .from('user_sites')
      .select('*')
      .eq('user_id', user.id)
      .order('last_modified', { ascending: false });

    if (error) {
      console.error('List sites error:', error);
      throw new AppError('Failed to list sites', 500, 'LIST_FAILED');
    }

    res.json({
      success: true,
      sites: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
});

// ============================================
// GET /sites/:urlDigest
// ============================================
router.get('/:urlDigest', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { urlDigest } = req.params;

    const { data, error } = await supabaseAdmin
      .from('user_sites')
      .select('*')
      .eq('user_id', user.id)
      .eq('url_digest', urlDigest)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Get site error:', error);
      throw new AppError('Failed to get site', 500, 'GET_FAILED');
    }

    if (!data) {
      res.status(404).json({
        error: 'Site not found',
        code: 'NOT_FOUND',
      });
      return;
    }

    res.json({
      success: true,
      site: data,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
});

// ============================================
// DELETE /sites/:urlDigest
// ============================================
router.delete('/:urlDigest', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { urlDigest } = req.params;

    const { error } = await supabaseAdmin
      .from('user_sites')
      .delete()
      .eq('user_id', user.id)
      .eq('url_digest', urlDigest);

    if (error) {
      console.error('Delete site error:', error);
      throw new AppError('Failed to delete site', 500, 'DELETE_FAILED');
    }

    res.json({
      success: true,
      message: 'Site deleted',
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
});

export default router;

