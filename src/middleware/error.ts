import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { isDev } from '../config/env.js';

/**
 * Custom error class with status code
 * Used for throwing HTTP errors with proper status codes
 */
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * 404 handler - catches unmatched routes
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
}

/**
 * Format Zod validation errors for client response
 * (OWASP: Provide helpful error messages without exposing internal details)
 */
function formatZodError(error: ZodError): { field: string; message: string }[] {
  return error.errors.map((err) => ({
    field: err.path.join('.') || 'body',
    message: err.message,
  }));
}

/**
 * Global error handler (OWASP: Centralized error handling)
 * 
 * Ensures:
 * - Consistent error response format
 * - No stack traces or internal details leaked in production
 * - Proper HTTP status codes
 * - Helpful validation error messages
 */
export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // Log error for debugging (server-side only)
  console.error('Error:', err);

  // Handle known AppError
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  }

  // Handle Stripe errors
  if (err.name === 'StripeError') {
    return res.status(400).json({
      error: err.message,
      code: 'STRIPE_ERROR',
    });
  }

  // Handle Zod validation errors with detailed field-level feedback
  // (OWASP: Provide helpful validation errors without exposing internals)
  if (err instanceof ZodError || err.name === 'ZodError') {
    const zodErr = err as ZodError;
    return res.status(400).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      // Always show field-level errors (these help users fix their requests)
      details: formatZodError(zodErr),
    });
  }

  // Generic error response - never expose internal error details in production
  // (OWASP: Error Handling - don't leak implementation details)
  return res.status(500).json({
    error: isDev ? err.message : 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}

