import Preferences from '@/components/preferences';
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Preferences token={token} />;
}
