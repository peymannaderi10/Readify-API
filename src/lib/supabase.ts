import { createClient, User } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Public client (for operations that use user's JWT)
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

// Admin client (for privileged operations)
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Verify a JWT and get the user
export async function verifyToken(token: string): Promise<User | null> {
  try {
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data.user) {
      return null;
    }
    
    return data.user;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Get user's subscription status from user_profiles table
export async function getUserSubscription(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_status, stripe_customer_id, stripe_subscription_id, cancelled_at, subscription_ends_at')
    .eq('id', userId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
    console.error('Error fetching subscription:', error);
    return null;
  }

  return data;
}

// Check if user has premium subscription
export async function isPremiumUser(userId: string): Promise<boolean> {
  const profile = await getUserSubscription(userId);
  
  if (!profile) return false;
  
  const status = profile.subscription_status;
  // 'active', 'trialing', 'canceling' all have premium access
  // 'canceling' means cancelled but still within paid period
  return ['active', 'trialing', 'canceling'].includes(status);
}

// Get full subscription details for API response
export async function getSubscriptionDetails(userId: string) {
  const profile = await getUserSubscription(userId);
  
  if (!profile) {
    return {
      status: 'free',
      isPremium: false,
      canAccessPremiumFeatures: false,
    };
  }
  
  const status = profile.subscription_status || 'free';
  const isPremium = ['active', 'trialing', 'canceling'].includes(status);
  
  return {
    status,
    isPremium,
    canAccessPremiumFeatures: isPremium,
    stripeCustomerId: profile.stripe_customer_id,
    stripeSubscriptionId: profile.stripe_subscription_id,
    cancelledAt: profile.cancelled_at,
    subscriptionEndsAt: profile.subscription_ends_at,
  };
}

