/** Money helpers. Everything is stored and calculated in integer cents. */
export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => Math.round(cents) / 100;
export const minuteRateCents = (hourlyRateCents: number): number => hourlyRateCents / 60;
