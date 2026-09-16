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
