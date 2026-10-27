import type { Metadata } from 'next';
import './globals.css';
import Navbar from '@/components/Navbar';

export const metadata: Metadata = {
  title: { default: 'Reel Pipeline', template: '%s · Reel Pipeline' },
  description: 'Short-form AI tool video generation pipeline — extract, script, match, QA, and assemble Instagram Reels and TikToks automatically.',
  keywords: ['AI tools', 'reels', 'TikTok', 'Instagram', 'video pipeline', 'content automation'],
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <main>{children}</main>
      </body>
    </html>
  );
}
