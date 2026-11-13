import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Baunthiyal Path Lab | Design Preview',
  description:
    'Your Health, Our Priority. Secure diagnostic collection center campaign management.',
  icons: { icon: '/logo.svg' },
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
