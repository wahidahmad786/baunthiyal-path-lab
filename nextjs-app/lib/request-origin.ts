/** Use the configured public origin behind a reverse proxy; never trust forwarded headers. */
export function allowedRequestOrigin(request: Request, appOrigin?: string): boolean {
  try {
    const expected = new URL(appOrigin || request.url);
    if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password)
      return false;
    return request.headers.get('origin') === expected.origin;
  } catch {
    return false;
  }
}
