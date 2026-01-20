/**
 * Firebase Functions for Stripe Integration
 * Using 2nd Gen Functions (requires Blaze plan)
 */

const { onCall, onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// Define secrets (more secure than environment variables)
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

// Regular config for app URL
const APP_URL = process.env.APP_URL || 'https://policyworth.vercel.app';

admin.initializeApp();
const db = admin.firestore();

/**
 * Create Stripe Checkout Session
 */
exports.createCheckoutSession = onCall(
  { 
    secrets: [stripeSecretKey],
    cors: ['https://policyworth.vercel.app', 'http://localhost:5000']
  },
  async (request) => {
    // Verify user is authenticated
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    // Initialize Stripe with secret
    const stripe = require('stripe')(stripeSecretKey.value());

    const userId = request.auth.uid;
    const { priceId, packageData } = request.data;

    try {
      // Get user data
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();

      // Create Stripe customer if doesn't exist
      let customerId = userData?.stripeCustomerId;
      
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: request.auth.token.email,
          metadata: {
            firebaseUID: userId,
            name: userData?.name || '',
            organization: userData?.organization || ''
          }
        });
        
        customerId = customer.id;
        
        // Save Stripe customer ID to Firestore
        await db.collection('users').doc(userId).update({
          stripeCustomerId: customerId
        });
      }

      // Create Checkout Session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: packageData.name,
                description: packageData.subtitle || packageData.name,
              },
              unit_amount: (packageData.price + (packageData.setupFee || 0)) * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          userId: userId,
          packageId: packageData.id,
          packageName: packageData.name,
          annualPrice: packageData.price,
          setupFee: packageData.setupFee || 0
        },
        success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/pricing.html`,
      });

      return {
        sessionId: session.id,
        url: session.url
      };

    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw new Error(error.message);
    }
  }
);

/**
 * Stripe Webhook Handler
 */
exports.stripeWebhook = onRequest(
  { 
    secrets: [stripeSecretKey, stripeWebhookSecret],
    cors: ['https://api.stripe.com']
  },
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    // Initialize Stripe
    const stripe = require('stripe')(stripeSecretKey.value());

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'payment_intent.succeeded':
        console.log('PaymentIntent succeeded:', event.data.object.id);
        break;
      
      case 'payment_intent.payment_failed':
        console.log('PaymentIntent failed:', event.data.object.id);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

/**
 * Handle successful checkout
 */
async function handleCheckoutCompleted(session) {
  const userId = session.metadata.userId;
  const packageId = session.metadata.packageId;
  const packageName = session.metadata.packageName;

  try {
    // Update user subscription in Firestore
    await db.collection('users').doc(userId).update({
      subscription: {
        packageId: packageId,
        packageName: packageName,
        status: 'active',
        startDate: admin.firestore.FieldValue.serverTimestamp(),
        renewalDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        stripeSessionId: session.id,
        amountPaid: session.amount_total / 100,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create payment record
    await db.collection('payments').add({
      userId: userId,
      stripeSessionId: session.id,
      packageId: packageId,
      packageName: packageName,
      amount: session.amount_total / 100,
      currency: session.currency,
      status: 'succeeded',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Subscription activated for user ${userId}`);
  } catch (error) {
    console.error('Error handling checkout completion:', error);
  }
}

/**
 * Get user subscription status
 */
exports.getSubscriptionStatus = onCall(
  {
    cors: ['https://policyworth.vercel.app', 'http://localhost:5000']
  },
  async (request) => {
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    const userId = request.auth.uid;

    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();

      if (!userData?.subscription) {
        return {
          hasSubscription: false,
          status: 'none'
        };
      }

      const subscription = userData.subscription;
      const now = new Date();
      const renewalDate = subscription.renewalDate?.toDate();

      const isExpired = renewalDate && renewalDate < now;

      return {
        hasSubscription: !isExpired,
        status: isExpired ? 'expired' : subscription.status,
        packageId: subscription.packageId,
        packageName: subscription.packageName,
        renewalDate: renewalDate?.toISOString(),
        daysUntilRenewal: renewalDate ? Math.ceil((renewalDate - now) / (1000 * 60 * 60 * 24)) : null
      };

    } catch (error) {
      console.error('Error getting subscription status:', error);
      throw new Error(error.message);
    }
  }
);

/**
 * Create Stripe Customer Portal session
 */
exports.createPortalSession = onCall(
  { 
    secrets: [stripeSecretKey],
    cors: ['https://policyworth.vercel.app', 'http://localhost:5000']
  },
  async (request) => {
    if (!request.auth) {
      throw new Error('User must be authenticated');
    }

    // Initialize Stripe
    const stripe = require('stripe')(stripeSecretKey.value());

    const userId = request.auth.uid;

    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const customerId = userDoc.data()?.stripeCustomerId;

      if (!customerId) {
        throw new Error('No Stripe customer found');
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${APP_URL}/dashboard.html`,
      });

      return {
        url: session.url
      };

    } catch (error) {
      console.error('Error creating portal session:', error);
      throw new Error(error.message);
    }
  }
);