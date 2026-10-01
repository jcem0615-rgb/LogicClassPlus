import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env, isStripeConfigured } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { publicInvoice } from '../lib/serialize.js';
import { fromCents, toCents } from '../lib/money.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { visibleStudentIds } from '../lib/scope.js';
import { invoiceNumber, stripe } from '../services/billing.js';
import { notify } from '../services/notifications.js';

export const billingRouter = Router();
billingRouter.use(requireAuth, requireRole('OWNER', 'STUDENT', 'PARENT'));

billingRouter.get('/invoices', asyncRoute(async (req, res) => {
  const me = actor(req);
  const ids = await visibleStudentIds(me);
  const where: Prisma.InvoiceWhereInput = ids === null ? {} : { studentId: { in: ids } };
  const invoices = await prisma.invoice.findMany({
    where, orderBy: { issuedAt: 'desc' }, take: 100, include: { lines: true },
  });
  res.json({
    invoices: invoices.map(publicInvoice),
    stripeConfigured: isStripeConfigured(),
    currency: env.PAYROLL_CURRENCY,
  });
}));

const createInvoice = z.object({
  studentId: z.string().min(1),
  dueAt: z.coerce.date(),
  currency: z.string().length(3).default('USD'),
  lines: z.array(z.object({
    label: z.string().trim().min(1).max(160),
    amount: z.number().positive().max(100_000),
  })).min(1, 'An invoice needs at least one line.'),
});

billingRouter.post('/invoices', requireRole('OWNER'), validate(createInvoice),
  asyncRoute(async (req, res) => {
    const input = req.body as z.infer<typeof createInvoice>;
    const student = await prisma.user.findUnique({ where: { id: input.studentId } });
    if (!student || student.role !== 'STUDENT') throw notFound('That student does not exist.');

    const amountCents = input.lines.reduce((sum, l) => sum + toCents(l.amount), 0);
    const count = await prisma.invoice.count();

    const invoice = await prisma.invoice.create({
      data: {
        number: invoiceNumber(count + 1), studentId: student.id, amountCents,
        currency: input.currency.toUpperCase(), status: 'OPEN', dueAt: input.dueAt,
        lines: { create: input.lines.map((l) => ({ label: l.label, amountCents: toCents(l.amount) })) },
      },
      include: { lines: true },
    });

    await notify({
      userId: student.id, type: 'billing', title: `Invoice ${invoice.number} is open`,
      body: `${invoice.currency} ${fromCents(amountCents).toFixed(2)} due ${input.dueAt.toDateString()}.`,
      url: '/#/billing',
    });

    res.status(201).json({ invoice: publicInvoice(invoice) });
  }));

/**
 * Invoice a group class: one invoice per student who has a seat, each for the
 * seat price.
 *
 * The seat price is what makes a group worth running for the student — six
 * people at nine dollars is cheaper for each of them than an hour alone and
 * better for the teacher than one. Billing the class once and splitting it
 * would come to the same number only until somebody drops out, so each seat
 * is its own invoice from the start.
 *
 * Re-running it skips students already invoiced for this class rather than
 * billing them twice, because the obvious way to use this button is to press
 * it again after a late booking.
 */
billingRouter.post('/invoices/for-class/:sessionId', requireRole('OWNER'),
  validate(z.object({ dueInDays: z.number().int().min(1).max(90).default(14) })),
  asyncRoute(async (req, res) => {
    const { dueInDays } = req.body as { dueInDays: number };
    const session = await prisma.classSession.findUnique({
      where: { id: String(req.params['sessionId']) },
      include: { participants: { include: { student: true } } },
    });
    if (!session) throw notFound('That class no longer exists.');
    if (session.seatPriceCents == null) {
      throw badRequest('That class has no seat price, so there is nothing to bill.');
    }
    if (!session.participants.length) throw badRequest('Nobody has booked that class.');

    const label = `${session.topic} — group seat, ${session.minutes} min`;
    const already = await prisma.invoiceLine.findMany({
      where: { label, invoice: { studentId: { in: session.participants.map((p) => p.studentId) } } },
      include: { invoice: { select: { studentId: true } } },
    });
    const billed = new Set(already.map((l) => l.invoice.studentId));
    const toBill = session.participants.filter((p) => !billed.has(p.studentId));

    const dueAt = new Date(Date.now() + dueInDays * 24 * 3600e3);
    const created = [];
    for (const seat of toBill) {
      const count = await prisma.invoice.count();
      const invoice = await prisma.invoice.create({
        data: {
          number: invoiceNumber(count + 1), studentId: seat.studentId,
          amountCents: session.seatPriceCents, currency: env.PAYROLL_CURRENCY,
          status: 'OPEN', dueAt,
          lines: { create: [{ label, amountCents: session.seatPriceCents }] },
        },
        include: { lines: true },
      });
      created.push(invoice);
      await notify({
        userId: seat.studentId, type: 'billing', title: `Invoice ${invoice.number} is open`,
        body: `${invoice.currency} ${fromCents(invoice.amountCents).toFixed(2)} for your seat in “${session.topic}”.`,
        url: '/#/billing',
      });
    }

    res.status(created.length ? 201 : 200).json({
      invoices: created.map(publicInvoice),
      skipped: session.participants.length - created.length,
    });
  }));

/**
 * Starts payment. With Stripe configured this creates a real PaymentIntent and
 * returns its client secret; the invoice is only marked paid by the webhook,
 * never by the browser saying so.
 */
billingRouter.post('/invoices/:id/pay', requireRole('STUDENT'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const invoice = await prisma.invoice.findUnique({ where: { id: String(req.params['id']) } });
  if (!invoice) throw notFound('That invoice no longer exists.');
  if (invoice.studentId !== me.id) throw forbidden('That invoice belongs to another student.');
  if (invoice.status !== 'OPEN') throw badRequest('That invoice is not open for payment.');

  const client = stripe();
  if (!client) {
    res.json({
      mode: 'unconfigured',
      message: 'Stripe keys are not set on this server, so no payment can be taken. '
        + 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to enable checkout.',
    });
    return;
  }

  const intent = await client.paymentIntents.create({
    amount: invoice.amountCents,
    currency: invoice.currency.toLowerCase(),
    metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number, studentId: me.id },
    automatic_payment_methods: { enabled: true },
  });
  await prisma.invoice.update({
    where: { id: invoice.id }, data: { stripePaymentIntentId: intent.id },
  });

  res.json({ mode: 'stripe', clientSecret: intent.client_secret, publishableKeyRequired: true });
}));

billingRouter.post('/invoices/:id/remind', requireRole('OWNER'), asyncRoute(async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: String(req.params['id']) } });
  if (!invoice) throw notFound('That invoice no longer exists.');
  await notify({
    userId: invoice.studentId, type: 'billing', title: 'Payment reminder',
    body: `${invoice.number} · ${invoice.currency} ${fromCents(invoice.amountCents).toFixed(2)} is due ${invoice.dueAt.toDateString()}.`,
    url: '/#/billing',
  });
  res.json({ ok: true });
}));

/** Manual settlement, for cash or a bank transfer taken outside Stripe. */
billingRouter.post('/invoices/:id/settle', requireRole('OWNER'), asyncRoute(async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: String(req.params['id']) }, include: { lines: true },
  });
  if (!invoice) throw notFound('That invoice no longer exists.');
  if (invoice.status === 'PAID') throw badRequest('That invoice is already paid.');

  const updated = await prisma.invoice.update({
    where: { id: invoice.id }, data: { status: 'PAID', paidAt: new Date() }, include: { lines: true },
  });
  await notify({
    userId: invoice.studentId, type: 'billing', title: 'Payment received',
    body: `${invoice.number} is settled. Thank you.`, url: '/#/billing',
  });
  res.json({ invoice: publicInvoice(updated) });
}));
