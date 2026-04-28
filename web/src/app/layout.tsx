import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Huddle Dashboard',
  description: 'Volume-tier decentralized coalitions via AXL Mesh.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
