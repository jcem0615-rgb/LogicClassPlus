import { Router, raw } from 'express';
import type Stripe from 'stripe';
import { prisma } from '../prisma.js';
import { env, isStripeConfigured } from '../env.js';
import { stripe } from '../services/billing.js';
import { notify } from '../services/notifications.js';

export const stripeWebhookRouter = Router();

/**
 * Mounted before the JSON body parser: Stripe signs the raw bytes, so the body
 * must not be re-serialised before the signature is checked.
 */
stripeWebhookRouter.post('/', raw({ type: 'application/json' }), (req, res) => {
  const client = stripe();
  if (!client || !isStripeConfigured() || !env.STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: { message: 'Stripe is not configured on this server.' } });
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    res.status(400).json({ error: { message: 'Missing Stripe signature.' } });
    return;
  }

  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(req.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    res.status(400).json({ error: { message: `Signature verification failed: ${(err as Error).message}` } });
    return;
  }

  // Acknowledge fast; do the work after.
  res.json({ received: true });
  void handle(event);
});

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const invoiceId = intent.metadata?.['invoiceId'];
      if (!invoiceId) return;
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice || invoice.status === 'PAID') return;

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'PAID', paidAt: new Date(), stripePaymentIntentId: intent.id },
      });
      await notify({
        userId: invoice.studentId, type: 'billing', title: 'Payment received',
        body: `${invoice.number} is settled. Thank you.`, url: '/#/billing',
      });
      const owners = await prisma.user.findMany({ where: { role: 'OWNER' }, select: { id: true } });
      for (const owner of owners) {
        await notify({
          userId: owner.id, type: 'billing', title: 'Invoice paid',
          body: `${invoice.number} · ${invoice.currency} ${(invoice.amountCents / 100).toFixed(2)}`,
          url: '/#/billing',
        });
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const invoiceId = intent.metadata?.['invoiceId'];
      const studentId = intent.metadata?.['studentId'];
      if (!invoiceId || !studentId) return;
      await notify({
        userId: studentId, type: 'billing', title: 'Payment failed',
        body: intent.last_payment_error?.message ?? 'Your card was declined. Try another payment method.',
        url: '/#/billing',
      });
      break;
    }
    default:
      break;
  }
}
