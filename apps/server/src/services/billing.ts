import { prisma } from '../prisma.js';
import Stripe from 'stripe';
import { env, isStripeConfigured } from '../env.js';

let client: Stripe | null = null;

export function stripe(): Stripe | null {
  if (!isStripeConfigured()) return null;
  if (!client) client = new Stripe(env.STRIPE_SECRET_KEY!);
  return client;
}

/** Next invoice number in the LC-#### series. */
export function invoiceNumber(sequence: number): string {
  return `LC-${String(2000 + sequence).padStart(4, '0')}`;
}

/**
 * The next free invoice number.
 *
 * This used to be `count() + 1`, which is not a sequence: the seeded
 * invoices start at LC-2041, so once the fortieth invoice existed the next
 * number was one that already did, the unique index rejected it, and raising
 * an invoice simply failed. Deleting one would do the same thing. The
 * highest number actually issued is the only safe thing to count from, and
 * the caller retries if two land at once.
 */
export async function nextInvoiceNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(CAST(SUBSTRING("number" FROM '[0-9]+$') AS INTEGER)) AS max FROM "Invoice"
  `;
  const highest = rows[0]?.max ?? 2000;
  return `LC-${String(highest + 1).padStart(4, '0')}`;
}

/**
 * Create an invoice, stepping the number if someone else took it first. The
 * gap between reading the highest number and writing the next one is small
 * and the retry closes it; a unique violation here means exactly one thing.
 */
export async function createInvoiceWithNumber<T>(
  make: (number: string) => Promise<T>,
  attempts = 5,
): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await make(await nextInvoiceNumber());
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error('Could not allocate an invoice number. Try again.');
}
