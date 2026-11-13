import 'server-only';
import { OAuth2Client } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth';
const oidc = new OAuth2Client();
export async function requireWorker(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  const secret = process.env.CRON_SECRET;
  if (secret && secret.length >= 32) {
    const a = Buffer.from(authorization),
      b = Buffer.from('Bearer ' + secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return;
  }
  const email = process.env.SCHEDULER_SERVICE_ACCOUNT;
  const audience = process.env.WORKER_OIDC_AUDIENCE;
  if (email && audience && authorization.startsWith('Bearer ')) {
    try {
      const ticket = await oidc.verifyIdToken({ idToken: authorization.slice(7), audience });
      const claims = ticket.getPayload();
      if (claims?.email_verified === true && claims.email === email) return;
    } catch {
      /* Never log bearer tokens or certificate errors. */
    }
  }
  throw new HttpError(401, 'Invalid worker credential');
}
