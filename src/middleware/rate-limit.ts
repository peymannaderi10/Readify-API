/**
 * Rate Limiting Middleware
 * 
 * Implements OWASP best practices for rate limiting:
 * - IP-based limiting for all requests
 * - Stricter limits for authenticated endpoints (by user ID)
 * - Very strict limits for expensive AI operations
 * - Graceful 429 responses with Retry-After headers
 * 
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 */

import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit';
import { Request, Response } from 'express';

// ============================================
// RATE LIMIT CONFIGURATION
// ============================================

/**
 * Normalize an IP address for rate limiting.
 * Uses express-rate-limit's ipKeyGenerator for proper IPv6 handling.
 * 
 * @param req - Express request object
 * @returns Normalized IP string suitable for rate limiting
 */
const normalizeIp = (req: Request): string => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // Use the library's helper to properly normalize IPv6 addresses
  return ipKeyGenerator(ip);
};

/**
 * Custom key generator that uses user ID for authenticated requests,
 * falls back to normalized IP for unauthenticated requests.
 * 
 * For authenticated users: Uses user ID (consistent regardless of IP)
 * For unauthenticated: Uses normalized IP with proper IPv6 handling
 */
const userOrIpKeyGenerator = (req: Request): string => {
  // Use user ID if authenticated (provides per-user limiting)
  // This is the primary key for authenticated routes - no IP needed
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  // Fall back to normalized IP address for unauthenticated requests
  return `ip:${normalizeIp(req)}`;
};

/**
 * Standard 429 response handler following OWASP guidelines
 */
const rateLimitHandler = (_req: Request, res: Response): void => {
  res.status(429).json({
    error: 'Too many requests',
    code: 'RATE_LIMITED',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

/**
 * Common options for all rate limiters
 */
const commonOptions: Partial<Options> = {
  // Use standard draft headers (RFC 6585)
  standardHeaders: true,
  // Disable legacy X-RateLimit headers
  legacyHeaders: false,
  // Custom handler for 429 responses
  handler: rateLimitHandler,
  // Skip successful requests from counting (optional - set to false for strictness)
  skipSuccessfulRequests: false,
};

// ============================================
// RATE LIMITERS
// ============================================

/**
 * Global rate limiter - applies to ALL requests
 * Prevents basic DoS attacks
 * 
 * Limit: 100 requests per minute per IP
 * Uses default keyGenerator which handles IPv6 properly
 */
export const globalRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  // Default keyGenerator uses req.ip with proper IPv6 handling
  message: 'Too many requests from this IP, please try again later.',
});

/**
 * Auth rate limiter - for login/signup endpoints
 * Prevents brute-force attacks on authentication
 * 
 * Limit: 5 attempts per 15 minutes per IP
 * Uses default keyGenerator which handles IPv6 properly
 */
export const authRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  // Default keyGenerator uses req.ip with proper IPv6 handling
  message: 'Too many authentication attempts, please try again later.',
});

/**
 * API rate limiter - for standard authenticated endpoints
 * Balances usability with protection
 * 
 * Limit: 60 requests per minute per user/IP
 */
export const apiRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many API requests, please slow down.',
});

/**
 * Strict API rate limiter - for expensive operations like sites/save
 * Prevents abuse of database-heavy operations
 * 
 * Limit: 30 requests per minute per user/IP
 */
export const strictApiRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many write requests, please slow down.',
});

/**
 * AI rate limiter - for AI endpoints (chat, TTS, realtime)
 * Very strict due to high cost of OpenAI API calls
 * 
 * Limit: 20 requests per minute per user
 */
export const aiRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 AI requests per minute
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many AI requests. AI features are rate limited to prevent abuse.',
});

/**
 * Stripe rate limiter - for payment-related endpoints
 * Moderate limits to prevent payment fraud attempts
 * 
 * Limit: 10 requests per minute per user
 */
export const stripeRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 payment requests per minute
  keyGenerator: userOrIpKeyGenerator,
  message: 'Too many payment requests, please try again later.',
});

/**
 * Webhook rate limiter - for incoming webhooks
 * Higher limits since webhooks come from trusted services (Stripe)
 * 
 * Limit: 100 requests per minute per IP
 * Uses default keyGenerator which handles IPv6 properly
 */
export const webhookRateLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute
  // Default keyGenerator uses req.ip with proper IPv6 handling
  message: 'Too many webhook requests.',
});
