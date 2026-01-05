import { supabaseAdmin } from './supabase.js';

// ============================================
// Per-Feature Token Limits Configuration
// ============================================

// Default limits (fallback if database is unavailable)
export const DEFAULT_LIMITS = {
  free: {
    chat: 50000,       // 50k tokens/month for chat
    tts: 10000,        // 10k characters/month for TTS
    realtime: 3000,    // ~2 minutes of realtime audio
  },
  premium: {
    chat: 2000000,     // 2M tokens/month for chat
    tts: 500000,       // 500k characters/month for TTS
    realtime: 100000,  // ~60 minutes of realtime audio
  },
};

// Cached limits from database
interface TierLimits {
  chat: number;
  tts: number;
  realtime: number;
}

interface LimitsCache {
  free: TierLimits;
  premium: TierLimits;
  lastFetched: number;
}

let limitsCache: LimitsCache | null = null;
const LIMITS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Export for backwards compatibility
export const TOKEN_LIMITS = DEFAULT_LIMITS;

export const WARNING_THRESHOLD = 0.8; // Warn at 80% usage

// ============================================
// Limits Functions
// ============================================

/**
 * Fetch tier limits from the database
 */
async function fetchLimitsFromDatabase(): Promise<LimitsCache | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tier_limits')
      .select('tier, chat_limit, tts_limit, realtime_limit');

    if (error) {
      console.error('Error fetching tier limits:', error);
      return null;
    }

    if (!data || data.length === 0) {
      return null;
    }

    const limits: LimitsCache = {
      free: { ...DEFAULT_LIMITS.free },
      premium: { ...DEFAULT_LIMITS.premium },
      lastFetched: Date.now(),
    };

    for (const row of data) {
      const tier = row.tier as 'free' | 'premium';
      if (tier === 'free' || tier === 'premium') {
        limits[tier] = {
          chat: row.chat_limit,
          tts: row.tts_limit,
          realtime: row.realtime_limit,
        };
      }
    }

    return limits;
  } catch (error) {
    console.error('Error fetching tier limits:', error);
    return null;
  }
}

/**
 * Get cached limits, refreshing from database if stale
 */
async function getCachedLimits(): Promise<LimitsCache> {
  const now = Date.now();
  
  // Return cached if still valid
  if (limitsCache && (now - limitsCache.lastFetched) < LIMITS_CACHE_TTL) {
    return limitsCache;
  }

  // Try to fetch from database
  const dbLimits = await fetchLimitsFromDatabase();
  
  if (dbLimits) {
    limitsCache = dbLimits;
    console.log('[TokenTracker] Refreshed limits from database:', {
      free: limitsCache.free,
      premium: limitsCache.premium,
    });
    return limitsCache;
  }

  // Fallback to defaults
  if (!limitsCache) {
    limitsCache = {
      free: { ...DEFAULT_LIMITS.free },
      premium: { ...DEFAULT_LIMITS.premium },
      lastFetched: now,
    };
  }

  return limitsCache;
}

/**
 * Get current limits (for API responses)
 */
export async function getCurrentLimits(): Promise<{ free: TierLimits; premium: TierLimits }> {
  const cached = await getCachedLimits();
  return {
    free: cached.free,
    premium: cached.premium,
  };
}

/**
 * Clear the limits cache (call when limits are updated)
 */
export function clearLimitsCache(): void {
  limitsCache = null;
}

// ============================================
// Types
// ============================================
export type Endpoint = 'chat' | 'tts' | 'realtime';

export interface TokenUsage {
  userId: string;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
  model: string;
  endpoint: Endpoint;
}

export interface FeatureUsage {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  isWarning: boolean;
  allowed: boolean;
}

export interface FeatureCheckResult extends FeatureUsage {
  resetDate: string;
}

export interface AllFeaturesStats {
  tier: 'free' | 'premium';
  chat: FeatureUsage;
  tts: FeatureUsage;
  realtime: FeatureUsage;
  resetDate: string;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get the start of the current month as a date string (YYYY-MM-DD)
 */
function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
}

/**
 * Get the date when usage resets (start of next month)
 */
function getNextResetDate(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

/**
 * Get limits for a specific tier (async, uses database cache)
 */
async function getLimitsAsync(isPremium: boolean): Promise<TierLimits> {
  const cached = await getCachedLimits();
  return isPremium ? cached.premium : cached.free;
}

/**
 * Calculate usage stats for a feature
 */
function calculateFeatureUsage(used: number, limit: number): FeatureUsage {
  const remaining = Math.max(0, limit - used);
  const percentUsed = Math.round((used / limit) * 100);
  
  return {
    used,
    limit,
    remaining,
    percentUsed,
    isWarning: percentUsed >= WARNING_THRESHOLD * 100,
    allowed: used < limit,
  };
}

// ============================================
// Core Functions
// ============================================

/**
 * Record token usage after an AI API call
 */
export async function recordTokenUsage(usage: TokenUsage): Promise<void> {
  const { userId, tokensUsed, promptTokens, completionTokens, model, endpoint } = usage;
  
  try {
    // Insert detailed usage record
    const { error: insertError } = await supabaseAdmin
      .from('token_usage')
      .insert({
        user_id: userId,
        tokens_used: tokensUsed,
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        model,
        endpoint,
      });

    if (insertError) {
      console.error('Error recording token usage:', insertError);
    }

    // Update per-feature monthly aggregate using the new atomic function
    const monthStart = getMonthStart();
    
    const { error: rpcError } = await supabaseAdmin.rpc('increment_feature_tokens', {
      p_user_id: userId,
      p_amount: tokensUsed,
      p_endpoint: endpoint,
      p_month_start: monthStart,
    });

    if (rpcError) {
      console.error('Error incrementing feature tokens:', rpcError);
    }
  } catch (error) {
    console.error('Token tracking error:', error);
    // Don't throw - token tracking should not break the main request
  }
}

/**
 * Check if user has remaining quota for a specific endpoint
 */
export async function checkFeatureLimit(
  userId: string, 
  isPremium: boolean, 
  endpoint: Endpoint
): Promise<FeatureCheckResult> {
  const limits = await getLimitsAsync(isPremium);
  const limit = limits[endpoint];
  const monthStart = getMonthStart();

  try {
    const { data, error } = await supabaseAdmin
      .from('user_token_limits')
      .select('chat_tokens_used, tts_chars_used, realtime_tokens_used, month_start')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error checking feature limit:', error);
    }

    // Determine which column to check based on endpoint
    let used = 0;
    if (data && data.month_start === monthStart) {
      switch (endpoint) {
        case 'chat':
          used = data.chat_tokens_used || 0;
          break;
        case 'tts':
          used = data.tts_chars_used || 0;
          break;
        case 'realtime':
          used = data.realtime_tokens_used || 0;
          break;
      }
    }
    // If different month or no data, usage is 0 (will reset on first use)

    const featureUsage = calculateFeatureUsage(used, limit);

    return {
      ...featureUsage,
      resetDate: getNextResetDate(),
    };
  } catch (error) {
    console.error('Feature limit check error:', error);
    // On error, allow the request but log it
    return {
      used: 0,
      limit,
      remaining: limit,
      percentUsed: 0,
      isWarning: false,
      allowed: true,
      resetDate: getNextResetDate(),
    };
  }
}

/**
 * Legacy function for backwards compatibility - checks overall token limit
 * @deprecated Use checkFeatureLimit instead
 */
export async function checkTokenLimit(userId: string, isPremium: boolean): Promise<FeatureCheckResult> {
  // For backwards compatibility, check chat limit (most commonly used)
  return checkFeatureLimit(userId, isPremium, 'chat');
}

/**
 * Get comprehensive usage stats for all features
 */
export async function getUsageStats(userId: string, isPremium: boolean): Promise<AllFeaturesStats> {
  const limits = await getLimitsAsync(isPremium);
  const monthStart = getMonthStart();

  try {
    const { data, error } = await supabaseAdmin
      .from('user_token_limits')
      .select('chat_tokens_used, tts_chars_used, realtime_tokens_used, month_start')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching usage stats:', error);
    }

    // Default values if no data or new month
    let chatUsed = 0;
    let ttsUsed = 0;
    let realtimeUsed = 0;

    if (data && data.month_start === monthStart) {
      chatUsed = data.chat_tokens_used || 0;
      ttsUsed = data.tts_chars_used || 0;
      realtimeUsed = data.realtime_tokens_used || 0;
    }

    return {
      tier: isPremium ? 'premium' : 'free',
      chat: calculateFeatureUsage(chatUsed, limits.chat),
      tts: calculateFeatureUsage(ttsUsed, limits.tts),
      realtime: calculateFeatureUsage(realtimeUsed, limits.realtime),
      resetDate: getNextResetDate(),
    };
  } catch (error) {
    console.error('Usage stats error:', error);
    // Return default stats on error
    return {
      tier: isPremium ? 'premium' : 'free',
      chat: calculateFeatureUsage(0, limits.chat),
      tts: calculateFeatureUsage(0, limits.tts),
      realtime: calculateFeatureUsage(0, limits.realtime),
      resetDate: getNextResetDate(),
    };
  }
}

/**
 * Get detailed usage history for a user (last N days)
 */
export async function getUsageHistory(userId: string, days: number = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  try {
    const { data, error } = await supabaseAdmin
      .from('token_usage')
      .select('tokens_used, model, endpoint, created_at')
      .eq('user_id', userId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Error fetching usage history:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Usage history error:', error);
    return [];
  }
}

