import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { apiRateLimiter, strictApiRateLimiter } from '../middleware/rate-limit.js';

const router = Router();

const FREE_SITE_LIMIT = 5;

// ============================================
// VALIDATION CONSTANTS (OWASP: Define reasonable limits)
// ============================================
const MAX_URL_DIGEST_LENGTH = 128;     // SHA-256 hex = 64 chars, allow some buffer
const MAX_URL_LENGTH = 2048;           // Standard max URL length
const MAX_TITLE_LENGTH = 500;          // Max page title
const MAX_HOSTNAME_LENGTH = 255;       // Max DNS hostname length
const MAX_CHANGES_COUNT = 1000;        // Max number of changes per site
const MAX_CHANGE_TEXT_LENGTH = 10000;  // Max text per change
const MAX_NOTE_CONTENT_LENGTH = 50000; // Max content per note

/**
 * Schema for segment within a change (text selection segment)
 */
const segmentSchema = z.object({
  text: z.string().max(MAX_CHANGE_TEXT_LENGTH).optional(),
  xpath: z.string().max(2000).optional(),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
}).passthrough();

/**
 * Schema for individual text change/highlight (OWASP: Strict type validation)
 * Matches the actual structure from the extension:
 * { type, data, markId, highlightId, text, segments, noteText, createdAt }
 */
const changeSchema = z.object({
  // Core identifiers - at least one should be present
  markId: z.string().max(100).optional(),
  highlightId: z.string().max(100).optional(),
  
  // Change type and data
  type: z.string().max(50).optional(), // 'highlight', 'underline', etc.
  data: z.union([z.string().max(50), z.null()]).optional(), // color or null
  
  // Text content
  text: z.string().max(MAX_CHANGE_TEXT_LENGTH).optional(),
  noteText: z.union([z.string().max(MAX_NOTE_CONTENT_LENGTH), z.null()]).optional(),
  
  // Segments array for multi-part selections
  segments: z.array(segmentSchema).max(100).optional(),
  
  // Timestamp
  createdAt: z.number().optional(),
  
  // Legacy fields (for backwards compatibility)
  originalText: z.string().max(MAX_CHANGE_TEXT_LENGTH).optional(),
  modifiedText: z.string().max(MAX_CHANGE_TEXT_LENGTH).optional(),
  color: z.string().max(50).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  xpath: z.string().max(2000).optional(),
  textOffset: z.number().int().min(0).optional(),
  textLength: z.number().int().min(0).optional(),
}).passthrough(); // Allow additional fields for forwards compatibility

/**
 * Schema for individual note (OWASP: Strict type validation)
 * Notes are stored as a record with markId as key
 */
const noteSchema = z.object({
  // Note can have various structures, be permissive but limit sizes
  id: z.string().max(100).optional(),
  markId: z.string().max(100).optional(),
  content: z.string().max(MAX_NOTE_CONTENT_LENGTH).optional(),
  text: z.string().max(MAX_CHANGE_TEXT_LENGTH).optional(),
  noteText: z.string().max(MAX_NOTE_CONTENT_LENGTH).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  createdAt: z.number().optional(),
  position: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
  }).optional(),
}).passthrough(); // Allow additional fields for forwards compatibility

// ============================================
// POST /sites/save
// ============================================

/**
 * Save site schema with strict validation (OWASP: Input Validation)
 * - All fields have explicit type checks and length limits
 * - Nested objects are validated with their own schemas
 * - Arrays have count limits to prevent DoS
 */
const saveSiteSchema = z.object({
  url_digest: z.string()
    .min(1, 'URL digest is required')
    .max(MAX_URL_DIGEST_LENGTH, `URL digest cannot exceed ${MAX_URL_DIGEST_LENGTH} characters`)
    .regex(/^[a-zA-Z0-9_-]+$/, 'URL digest must be alphanumeric'),
  url: z.string()
    .max(MAX_URL_LENGTH, `URL cannot exceed ${MAX_URL_LENGTH} characters`)
    .optional(),
  title: z.string()
    .max(MAX_TITLE_LENGTH, `Title cannot exceed ${MAX_TITLE_LENGTH} characters`)
    .optional(),
  hostname: z.string()
    .max(MAX_HOSTNAME_LENGTH, `Hostname cannot exceed ${MAX_HOSTNAME_LENGTH} characters`)
    .optional(),
  changes: z.array(changeSchema)
    .max(MAX_CHANGES_COUNT, `Cannot exceed ${MAX_CHANGES_COUNT} changes per site`)
    .optional(),
  notes: z.record(
    z.string().max(100), // Note ID as key
    noteSchema
  ).optional(),
}).strict(); // Reject unexpected fields

// Apply strict rate limiting (30 req/min) for write operations + auth
router.post('/save', strictApiRateLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
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
// Apply standard rate limiting (60 req/min) for read operations + auth
router.get('/list', apiRateLimiter, requireAuth, async (req: Request, res: Response) => {
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

/**
 * URL param validation schema (OWASP: Validate all input including route params)
 */
const urlDigestParamSchema = z.string()
  .min(1, 'URL digest is required')
  .max(MAX_URL_DIGEST_LENGTH, `URL digest cannot exceed ${MAX_URL_DIGEST_LENGTH} characters`)
  .regex(/^[a-zA-Z0-9_-]+$/, 'URL digest must be alphanumeric');

// Apply standard rate limiting (60 req/min) for read operations + auth
router.get('/:urlDigest', apiRateLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    
    // Validate URL parameter (OWASP: Never trust user input, including route params)
    const urlDigestResult = urlDigestParamSchema.safeParse(req.params.urlDigest);
    if (!urlDigestResult.success) {
      throw new AppError('Invalid URL digest parameter', 400, 'VALIDATION_ERROR');
    }
    const urlDigest = urlDigestResult.data;

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
// Apply strict rate limiting (30 req/min) for delete operations + auth
router.delete('/:urlDigest', strictApiRateLimiter, requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    
    // Validate URL parameter (OWASP: Never trust user input, including route params)
    const urlDigestResult = urlDigestParamSchema.safeParse(req.params.urlDigest);
    if (!urlDigestResult.success) {
      throw new AppError('Invalid URL digest parameter', 400, 'VALIDATION_ERROR');
    }
    const urlDigest = urlDigestResult.data;

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

