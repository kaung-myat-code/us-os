import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Relationship OS',
  description: 'A private, end-to-end encrypted workspace for couples.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
