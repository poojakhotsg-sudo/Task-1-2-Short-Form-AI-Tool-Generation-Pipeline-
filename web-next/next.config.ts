import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents and partialPrefetching are experimental flags that conflict
  // with `export const dynamic = 'force-dynamic'` on API routes. Removed so
  // Supabase-backed routes are never pre-rendered at build time.
  partialPrefetching: false,
};

export default nextConfig;
