import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { normalizeIp } from '../security/cidr.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const conflict = (msg: string, code?: string) => new HttpError(409, msg, code);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw badRequest(`${where}${first?.message ?? 'Invalid request'}`, 'VALIDATION');
  }
  return r.data;
}

export function clientIp(req: FastifyRequest): string {
  return normalizeIp(req.ip);
}

export function userAgent(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 300);
}

/** Audit actor fields for a request. */
export function actor(req: FastifyRequest) {
  return { userId: req.auth?.user.id ?? null, username: req.auth?.user.username ?? null, ip: clientIp(req) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
