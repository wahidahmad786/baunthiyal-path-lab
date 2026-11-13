import 'server-only';
import { cookies } from 'next/headers';
import { auth, publicOrigin } from './firebase';
import { hasLabAdminAccess } from '../access';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function requireStaff() {
  const cookie = (await cookies()).get('bpl_session')?.value;
  if (!cookie) throw new HttpError(401, 'Please sign in to continue');
  try {
    const claims = await auth().verifySessionCookie(cookie, true);
    if (!hasLabAdminAccess(claims))
      throw new HttpError(403, 'An administrator account is required');
    return claims;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'Your session expired. Please sign in again');
  }
}
export function checkOrigin(request: Request) {
  if (request.headers.get('origin') !== publicOrigin())
    throw new HttpError(403, 'Request origin is not allowed');
}
export async function requireMutation(request: Request) {
  checkOrigin(request);
  return requireStaff();
}
export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof Error && e.name === 'ZodError')
    return Response.json(
      {
        error: JSON.parse(e.message)
          .map(
            (issue: { path: string[]; message: string }) =>
              `${issue.path.join('.')}: ${issue.message}`,
          )
          .join('; '),
      },
      { status: 400 },
    );
  console.error('Request failed:', e instanceof Error ? e.message : 'unknown');
  return Response.json(
    {
      error: 'The operation could not be completed. Check the server configuration and try again.',
    },
    { status: 500 },
  );
}
