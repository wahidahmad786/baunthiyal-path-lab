/** A lab-only claim prevents unrelated apps in this shared Firebase project granting lab access. */
export function hasLabAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.bplAdmin === true;
}
