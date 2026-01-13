/**
 * Firebase Functions for Stripe Integration
 * 
 * SETUP INSTRUCTIONS:
 * 
 * 1. Install Firebase CLI:
 *    npm install -g firebase-tools
 * 
 * 2. Initialize Firebase Functions in your project:
 *    firebase init functions
 *    - Choose JavaScript or TypeScript
 *    - Install dependencies
 * 
 * 3. Install Stripe:
 *    cd functions
 *    npm install stripe
 * 
 * 4. Set Stripe keys as environment variables:
 *    firebase functions:config:set stripe.secret_key="sk_test_YOUR_KEY"
 *    firebase functions:config:set stripe.webhook_secret="whsec_YOUR_SECRET"
 * 
 * 5. Deploy functions:
 *    firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe')(functions.config().stripe.secret_key);

admin.initializeApp();
const db = admin.firestore();

/**
 * Create Stripe Checkout Session
 * Called from /checkout.html
 */
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  // Verify user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated'
    );
  }

  const userId = context.auth.uid;
  const { priceId, packageData } = data;

  try {
    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // Create Stripe customer if doesn't exist
    let customerId = userData?.stripeCustomerId;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: context.auth.token.email,
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
      mode: 'payment', // For one-time payments (subscription + setup)
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: packageData.name,
              description: packageData.subtitle || packageData.name,
            },
            unit_amount: (packageData.price + (packageData.setupFee || 0)) * 100, // Convert to cents
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
      success_url: `${functions.config().app.url || 'http://localhost:5000'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${functions.config().app.url || 'http://localhost:5000'}/pricing.html`,
    });

    return {
      sessionId: session.id,
      url: session.url
    };

  } catch (error) {
    console.error('Error creating checkout session:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Stripe Webhook Handler
 * Handles payment confirmations and subscription events
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = functions.config().stripe.webhook_secret;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
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
});

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
        // For annual subscriptions, set renewal date to 1 year from now
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
 * Called from dashboard to check access
 */
exports.getSubscriptionStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated'
    );
  }

  const userId = context.auth.uid;

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

    // Check if subscription is expired
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Create Stripe Customer Portal session
 * Allows users to manage their subscription
 */
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated'
    );
  }

  const userId = context.auth.uid;

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const customerId = userDoc.data()?.stripeCustomerId;

    if (!customerId) {
      throw new functions.https.HttpsError(
        'not-found',
        'No Stripe customer found'
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${functions.config().app.url || 'http://localhost:5000'}/dashboard.html`,
    });

    return {
      url: session.url
    };

  } catch (error) {
    console.error('Error creating portal session:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});