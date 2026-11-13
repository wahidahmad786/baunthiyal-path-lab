import Link from 'next/link';

export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Policies and contact">
      <Link href="/privacy-policy">Privacy policy</Link>
      <Link href="/terms">Terms</Link>
      <Link href="/data-deletion">Data deletion</Link>
      <Link href="/contact">Contact</Link>
    </nav>
  );
}
