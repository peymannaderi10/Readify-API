import { Request, Response, NextFunction } from 'express';
import { verifyToken, isPremiumUser } from '../lib/supabase.js';
import { User } from '@supabase/supabase-js';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      token?: string;
    }
  }
}

// Authentication middleware - requires valid JWT
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'No authorization header',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const token = authHeader.replace('Bearer ', '');
    const user = await verifyToken(token);

    if (!user) {
      res.status(401).json({
        error: 'Invalid or expired token',
        code: 'AUTH_INVALID',
      });
      return;
    }

    // Attach user and token to request
    req.user = user;
    req.token = token;

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
}

// Optional auth - attaches user if token present, but doesn't require it
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      const user = await verifyToken(token);

      if (user) {
        req.user = user;
        req.token = token;
      }
    }

    next();
  } catch (error) {
    // Don't fail on optional auth errors
    next();
  }
}

// Premium subscription required middleware
// Must be used AFTER requireAuth middleware
export async function requirePremium(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Ensure user is authenticated first
    if (!req.user) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    // Check premium status from Supabase
    const hasPremium = await isPremiumUser(req.user.id);

    if (!hasPremium) {
      res.status(403).json({
        error: 'Premium subscription required',
        code: 'PREMIUM_REQUIRED',
        upgrade: true,
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Premium check error:', error);
    res.status(500).json({
      error: 'Subscription verification failed',
      code: 'PREMIUM_CHECK_ERROR',
    });
  }
}

