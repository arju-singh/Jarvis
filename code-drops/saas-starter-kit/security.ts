/**
 * security — headers + strict body validation. No deps.
 *
 *   • securityHeaders(opts?) — nosniff / frame-deny / referrer / optional CSP.
 *   • validateBody(schema)   — allow-list validation (rejects unexpected fields,
 *                              wrong types, over-length strings — anti mass-assignment).
 */
import type { Request, Response, NextFunction } from "express";

export function securityHeaders(opts: { csp?: string } = {}) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (opts.csp) res.setHeader("Content-Security-Policy", opts.csp);
    next();
  };
}

export interface FieldSpec {
  type: "string" | "number" | "boolean";
  required?: boolean;
  maxLen?: number;
  min?: number;
  max?: number;
  trim?: boolean;
}
export type Schema = Record<string, FieldSpec>;
export class ValidationError extends Error {}

export function validate(body: unknown, schema: Schema): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("body must be a JSON object");
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!(key in schema)) throw new ValidationError(`unexpected field: ${key}`);

  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const present = obj[name] !== undefined && obj[name] !== null;
    if (!present) { if (spec.required) throw new ValidationError(`missing required field: ${name}`); continue; }
    let val = obj[name];
    if (spec.type === "string") {
      if (typeof val !== "string") throw new ValidationError(`${name} must be a string`);
      if (spec.trim) val = (val as string).trim();
      if (spec.required && (val as string).length === 0) throw new ValidationError(`${name} must not be empty`);
      if (spec.maxLen !== undefined && (val as string).length > spec.maxLen) throw new ValidationError(`${name} exceeds ${spec.maxLen} chars`);
    } else if (spec.type === "number") {
      if (typeof val !== "number" || Number.isNaN(val)) throw new ValidationError(`${name} must be a number`);
      if (spec.min !== undefined && val < spec.min) throw new ValidationError(`${name} too small`);
      if (spec.max !== undefined && val > spec.max) throw new ValidationError(`${name} too large`);
    } else if (spec.type === "boolean") {
      if (typeof val !== "boolean") throw new ValidationError(`${name} must be a boolean`);
    }
    out[name] = val;
  }
  return out;
}

export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { req.body = validate(req.body, schema); next(); }
    catch (err) { res.status(422).json({ error: `Invalid input: ${(err as Error).message}` }); }
  };
}
