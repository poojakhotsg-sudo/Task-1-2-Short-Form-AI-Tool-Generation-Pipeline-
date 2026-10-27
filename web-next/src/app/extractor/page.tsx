import type { Metadata } from 'next';
import ExtractorClient from './ExtractorClient';

export const metadata: Metadata = {
  title: 'Extractor',
  description: 'Paste one or more public URLs to extract videos, GIFs, images, and embeds from any AI tool website.',
};

export default function ExtractorPage() {
  return <ExtractorClient />;
}
