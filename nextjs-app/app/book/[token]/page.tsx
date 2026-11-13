import PublicOffer from '@/components/public-offer';
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicOffer token={token} />;
}
