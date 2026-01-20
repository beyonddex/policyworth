/**
 * Firebase Functions for Stripe Integration (2nd Gen)
 * - Checkout session: HTTPS onRequest (CORS + Firebase token verification)
 * - Webhook: HTTPS onRequest
 * - Subscription status + Portal: callable onCall (can keep as-is)
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const corsLib = require("cors");

// Define secrets
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// App URL
const APP_URL = process.env.APP_URL || "https://policyworth.vercel.app";

// CORS whitelist
const ALLOWED_ORIGINS = [
  "https://policyworth.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

// CORS middleware (for onRequest)
const cors = corsLib({
  origin: (origin, cb) => {
    // Allow non-browser requests (no Origin) like curl/Stripe/etc.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
});

admin.initializeApp();
const db = admin.firestore();

/**
 * ✅ Create Stripe Checkout Session (HTTP onRequest)
 * Call from browser via fetch() with Authorization: Bearer <Firebase ID token>
 */
exports.createCheckoutSessionHttp = onRequest(
  { secrets: [stripeSecretKey] },
  (req, res) => {
    cors(req, res, async () => {
      try {
        // Handle preflight
        if (req.method === "OPTIONS") {
          return res.status(204).send("");
        }

        if (req.method !== "POST") {
          return res.status(405).json({ error: "Method Not Allowed" });
        }

        // Verify Firebase ID token
        const authHeader = req.headers.authorization || "";
        const match = authHeader.match(/^Bearer (.+)$/);
        if (!match) {
          return res.status(401).json({ error: "Missing Authorization Bearer token" });
        }

        const decoded = await admin.auth().verifyIdToken(match[1]);
        const userId = decoded.uid;
        const userEmail = decoded.email || undefined;

        // Validate input
        const { priceId, packageData } = req.body || {};
        if (!packageData || !packageData.name || typeof packageData.price !== "number") {
          return res.status(400).json({ error: "Missing or invalid packageData" });
        }

        // Initialize Stripe
        const stripe = require("stripe")(stripeSecretKey.value());

        // Get user data
        const userRef = db.collection("users").doc(userId);
        const userDoc = await userRef.get();
        const userData = userDoc.exists ? userDoc.data() : {};

        // Create Stripe customer if doesn't exist
        let customerId = userData?.stripeCustomerId;

        if (!customerId) {
          const customer = await stripe.customers.create({
            email: userEmail,
            metadata: {
              firebaseUID: userId,
              name: userData?.name || "",
              organization: userData?.organization || "",
            },
          });

          customerId = customer.id;

          await userRef.set(
            {
              stripeCustomerId: customerId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        // Compute amount in cents (annual price + setup fee)
        const setupFee = Number(packageData.setupFee || 0);
        const annualPrice = Number(packageData.price);
        const unitAmountCents = Math.round((annualPrice + setupFee) * 100);

        if (!Number.isFinite(unitAmountCents) || unitAmountCents <= 0) {
          return res.status(400).json({ error: "Invalid pricing amounts" });
        }

        // Create Checkout Session
        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: packageData.name,
                  description: packageData.subtitle || packageData.name,
                },
                unit_amount: unitAmountCents,
              },
              quantity: 1,
            },
          ],
          metadata: {
            userId,
            packageId: packageData.id || "",
            packageName: packageData.name,
            annualPrice: String(annualPrice),
            setupFee: String(setupFee),
            priceId: priceId || "",
          },
          success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${APP_URL}/pricing.html`,
        });

        return res.json({ sessionId: session.id, url: session.url });
      } catch (error) {
        console.error("Error creating checkout session:", error);
        return res.status(500).json({ error: error?.message || "Internal error" });
      }
    });
  }
);

/**
 * Stripe Webhook Handler (onRequest)
 */
exports.stripeWebhook = onRequest(
  {
    secrets: [stripeSecretKey, stripeWebhookSecret],
    cors: true, // not required for Stripe, but fine
  },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const stripe = require("stripe")(stripeSecretKey.value());

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutCompleted(event.data.object);
          break;

        case "payment_intent.succeeded":
          console.log("PaymentIntent succeeded:", event.data.object.id);
          break;

        case "payment_intent.payment_failed":
          console.log("PaymentIntent failed:", event.data.object.id);
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (err) {
      console.error("Error handling webhook event:", err);
      // returning 200 avoids aggressive retries; change to 500 if you want retries
    }

    res.json({ received: true });
  }
);

async function handleCheckoutCompleted(session) {
  const userId = session?.metadata?.userId;
  const packageId = session?.metadata?.packageId;
  const packageName = session?.metadata?.packageName;

  if (!userId) {
    console.error("checkout.session.completed missing userId in metadata");
    return;
  }

  try {
    await db.collection("users").doc(userId).set(
      {
        subscription: {
          packageId: packageId || "",
          packageName: packageName || "",
          status: "active",
          startDate: admin.firestore.FieldValue.serverTimestamp(),
          renewalDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          stripeSessionId: session.id,
          amountPaid: (session.amount_total || 0) / 100,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await db.collection("payments").add({
      userId,
      stripeSessionId: session.id,
      packageId: packageId || "",
      packageName: packageName || "",
      amount: (session.amount_total || 0) / 100,
      currency: session.currency,
      status: "succeeded",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Subscription activated for user ${userId}`);
  } catch (error) {
    console.error("Error handling checkout completion:", error);
  }
}

/**
 * Get user subscription status (keep callable)
 */
exports.getSubscriptionStatus = onCall(
  { cors: ALLOWED_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const userId = request.auth.uid;

    try {
      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};

      if (!userData?.subscription) {
        return { hasSubscription: false, status: "none" };
      }

      const subscription = userData.subscription;
      const now = new Date();

      const renewalDate = subscription.renewalDate?.toDate
        ? subscription.renewalDate.toDate()
        : subscription.renewalDate
          ? new Date(subscription.renewalDate)
          : null;

      const isExpired = renewalDate && renewalDate < now;

      return {
        hasSubscription: !isExpired,
        status: isExpired ? "expired" : subscription.status,
        packageId: subscription.packageId,
        packageName: subscription.packageName,
        renewalDate: renewalDate ? renewalDate.toISOString() : null,
        daysUntilRenewal: renewalDate
          ? Math.ceil((renewalDate - now) / (1000 * 60 * 60 * 24))
          : null,
      };
    } catch (error) {
      console.error("Error getting subscription status:", error);
      throw new HttpsError("internal", error?.message || "Failed to get subscription status");
    }
  }
);

/**
 * Create Stripe Customer Portal session (keep callable)
 */
exports.createPortalSession = onCall(
  { cors: ALLOWED_ORIGINS, secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const stripe = require("stripe")(stripeSecretKey.value());
    const userId = request.auth.uid;

    try {
      const userDoc = await db.collection("users").doc(userId).get();
      const customerId = userDoc.exists ? userDoc.data()?.stripeCustomerId : null;

      if (!customerId) {
        throw new HttpsError("failed-precondition", "No Stripe customer found");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${APP_URL}/dashboard.html`,
      });

      return { url: session.url };
    } catch (error) {
      console.error("Error creating portal session:", error);
      throw new HttpsError("internal", error?.message || "Failed to create portal session");
    }
  }
);
