import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LEGAL_PAGES, LegalPage } from '@/components/legal-page';

export const dynamicParams = false;
export function generateStaticParams() {
  return Object.keys(LEGAL_PAGES).map((legal) => ({ legal }));
}
type Props = { params: Promise<{ legal: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { legal } = await params;
  if (!Object.hasOwn(LEGAL_PAGES, legal)) return {};
  return {
    title: `${LEGAL_PAGES[legal].title} | Baunthiyal Path Lab`,
    description: LEGAL_PAGES[legal].intro,
    robots: { index: true, follow: true },
  };
}
export default async function Page({ params }: Props) {
  const { legal } = await params;
  if (!Object.hasOwn(LEGAL_PAGES, legal)) notFound();
  return <LegalPage slug={legal} />;
}
