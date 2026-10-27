import type { Metadata } from 'next';
import LibraryClient from './LibraryClient';

export const metadata: Metadata = {
  title: 'Library',
  description: 'Browse all processed AI tools with their Reel Kits, hooks, lead magnets, and keyword links.',
};

export default function LibraryPage() {
  return <LibraryClient />;
}
