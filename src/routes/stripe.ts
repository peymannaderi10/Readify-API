import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { stripe, STRIPE_PRICE_ID } from '../lib/stripe.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { env } from '../config/env.js';
import Stripe from 'stripe';

const router = Router();

// ============================================
// POST /stripe/create-checkout-session
// ============================================
const checkoutSchema = z.object({
  priceId: z.string().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

router.post('/create-checkout-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const user = req.user!;

    const priceId = body.priceId || STRIPE_PRICE_ID;

    // Get or create Stripe customer
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          supabase_user_id: user.id,
        },
      });
      customerId = customer.id;

      // Save customer ID to profile
      await supabaseAdmin
        .from('user_profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: body.successUrl || 'https://readify.ca/success',
      cancel_url: body.cancelUrl || 'https://readify.ca/cancel',
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
        },
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create checkout session error:', error);
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// POST /stripe/create-portal-session
// ============================================
const portalSchema = z.object({
  returnUrl: z.string().url().optional(),
});

router.post('/create-portal-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = portalSchema.parse(req.body);
    const user = req.user!;

    // Get Stripe customer ID from profile
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      throw new AppError('No Stripe customer found for this user', 400, 'NO_CUSTOMER');
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: body.returnUrl || 'https://readify.ca/',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Create portal session error:', error);
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// POST /stripe/cancel-subscription
// ============================================
const cancelSchema = z.object({
  subscriptionId: z.string(),
});

router.post('/cancel-subscription', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = cancelSchema.parse(req.body);
    const user = req.user!;

    // Verify the subscription belongs to this user
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_subscription_id')
      .eq('id', user.id)
      .single();

    if (profile?.stripe_subscription_id !== body.subscriptionId) {
      throw new AppError('Subscription does not belong to this user', 403, 'FORBIDDEN');
    }

    // Cancel the subscription at the end of the current billing period
    const updatedSubscription = await stripe.subscriptions.update(body.subscriptionId, {
      cancel_at_period_end: true,
    });

    const periodEnd = new Date(updatedSubscription.current_period_end * 1000);
    console.log(`Subscription ${body.subscriptionId} set to cancel at period end (${periodEnd.toISOString()}) for user ${user.id}`);

    // Update user profile - still active but will cancel
    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .update({
        subscription_status: 'canceling',
        cancelled_at: new Date().toISOString(),
        subscription_ends_at: periodEnd.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (profileError) {
      console.error('Failed to update user_profiles:', profileError);
    }

    // Update subscriptions table
    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'active',
        cancel_at_period_end: true,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', body.subscriptionId);

    if (subError) {
      console.error('Failed to update subscriptions:', subError);
    }

    res.json({
      success: true,
      message: 'Subscription will be cancelled at the end of your billing period',
      status: updatedSubscription.status,
      cancel_at_period_end: true,
      current_period_end: periodEnd.toISOString(),
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) {
      throw new AppError('Invalid request body', 400, 'VALIDATION_ERROR');
    }
    throw error;
  }
});

// ============================================
// POST /stripe/webhook
// ============================================
router.post('/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    throw new AppError('No Stripe signature', 400, 'NO_SIGNATURE');
  }

  let event: Stripe.Event;

  try {
    // req.body should be raw buffer for webhook verification
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    throw new AppError('Invalid signature', 400, 'INVALID_SIGNATURE');
  }

  console.log('Received webhook event:', event.type);

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutCompleted(session);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionChange(subscription);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionDeleted(subscription);
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      await handleInvoicePaid(invoice);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      await handleInvoicePaymentFailed(invoice);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// ============================================
// Webhook Handlers
// ============================================

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  // Get full subscription details
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata.supabase_user_id;

  if (!userId) {
    console.error('No user ID found in subscription metadata');
    return;
  }

  // Update user profile
  await supabaseAdmin
    .from('user_profiles')
    .update({
      subscription_status: 'active',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  // Insert subscription record
  await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_subscription_id: subscriptionId,
    status: subscription.status,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, {
    onConflict: 'stripe_subscription_id',
  });

  console.log(`Checkout completed for user: ${userId}`);
}

async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const userId = subscription.metadata.supabase_user_id;

  if (!userId) {
    console.error('No user ID found in subscription metadata');
    return;
  }

  // Map Stripe status to our status
  let status: string = subscription.status;
  if (subscription.status === 'active' && subscription.cancel_at_period_end) {
    status = 'canceled'; // Will be canceled at end of period
  }

  // Update user profile
  await supabaseAdmin
    .from('user_profiles')
    .update({
      subscription_status: status,
      stripe_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  // Update subscription record
  await supabaseAdmin.from('subscriptions').upsert({
    user_id: userId,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, {
    onConflict: 'stripe_subscription_id',
  });

  console.log(`Subscription updated for user: ${userId}, status: ${status}`);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const userId = subscription.metadata.supabase_user_id;

  if (!userId) {
    console.error('No user ID found in subscription metadata');
    return;
  }

  // Delete all user's site data since subscription ended
  const { error: deleteError } = await supabaseAdmin
    .from('user_sites')
    .delete()
    .eq('user_id', userId);

  if (deleteError) {
    console.error('Error deleting user site data:', deleteError);
  } else {
    console.log(`Deleted site data for user: ${userId}`);
  }

  // Update user profile to free
  await supabaseAdmin
    .from('user_profiles')
    .update({
      subscription_status: 'free',
      stripe_subscription_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  // Update subscription record
  await supabaseAdmin
    .from('subscriptions')
    .update({
      status: 'canceled',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);

  console.log(`Subscription ended and data deleted for user: ${userId}`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Find user by customer ID
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!profile) {
    console.error('No user found for customer:', customerId);
    return;
  }

  // Record payment
  await supabaseAdmin.from('payment_history').insert({
    user_id: profile.id,
    stripe_payment_intent_id: invoice.payment_intent as string,
    stripe_invoice_id: invoice.id,
    amount: (invoice.amount_paid || 0) / 100, // Convert from cents
    currency: invoice.currency,
    status: 'succeeded',
  });

  console.log(`Invoice paid for user: ${profile.id}`);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Find user by customer ID
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!profile) {
    console.error('No user found for customer:', customerId);
    return;
  }

  // Update subscription status to past_due
  await supabaseAdmin
    .from('user_profiles')
    .update({
      subscription_status: 'past_due',
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);

  // Record failed payment
  await supabaseAdmin.from('payment_history').insert({
    user_id: profile.id,
    stripe_payment_intent_id: invoice.payment_intent as string,
    stripe_invoice_id: invoice.id,
    amount: (invoice.amount_due || 0) / 100,
    currency: invoice.currency,
    status: 'failed',
  });

  console.log(`Invoice payment failed for user: ${profile.id}`);
}

export default router;

