import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { badRequest } from './http-error.js';

type Source = 'body' | 'query' | 'params';

/** Zod validation for every request that carries input. */
export function validate<T>(schema: ZodSchema<T>, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(badRequest(firstMessage(result.error), fieldErrors(result.error)));
      return;
    }
    // Validated, coerced values replace the raw input.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };
}

function firstMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'That request was not valid.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function fieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join('.') || '_'] = issue.message;
  return out;
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncRoute<R extends Request>(
  fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req as R, res, next).catch(next);
  };
}
