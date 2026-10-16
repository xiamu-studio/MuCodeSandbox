import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

interface UISessionOptions {
  allowedOrigin: (origin?: string) => boolean;
}

function equalSecret(value: string, secret: string) {
  const supplied = Buffer.from(value);
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createUISession({ allowedOrigin }: UISessionOptions) {
  const launchSecret = randomBytes(32).toString('base64url');
  const sessionSecret = randomBytes(32).toString('base64url');
  const cookieName = `mu_ui_${randomBytes(8).toString('hex')}`;

  const isAuthorized = (request: Request) => {
    if (!allowedOrigin(request.headers.origin)) return false;
    const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${cookieName}=`)).map(value => value.slice(cookieName.length + 1));
    return values.length === 1 && equalSecret(values[0], sessionSecret);
  };

  const middleware: RequestHandler = (request, response, next) => {
    const url = new URL(request.originalUrl, 'http://127.0.0.1');
    const launches = url.searchParams.getAll('launch');
    if (launches.length) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' || launches.length !== 1 || !allowedOrigin(request.headers.origin) || !equalSecret(launches[0], launchSecret)) {
        response.status(403).type('text/plain').send('UI session authorization required');
        return;
      }
      response.setHeader('Set-Cookie', `${cookieName}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`);
      url.searchParams.delete('launch');
      response.redirect(302, `${url.pathname}${url.search}`);
      return;
    }
    if (url.pathname === '/' && !isAuthorized(request)) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.status(403).type('text/plain').send('UI session authorization required');
      return;
    }
    next();
  };

  const launchUrl = (origin: string, pathname = '/') => {
    const base = new URL(origin);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new TypeError('Expected a local UI origin');
    }
    const url = new URL(pathname, base);
    if (!pathname.startsWith('/') || pathname.startsWith('//') || url.origin !== base.origin || url.hash) throw new TypeError('Expected a local UI path');
    url.searchParams.set('launch', launchSecret);
    return url.href;
  };

  return { middleware, isAuthorized, launchUrl };
}
