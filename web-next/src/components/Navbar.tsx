'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/',          label: 'Pipeline' },
  { href: '/library',   label: 'Library'  },
  { href: '/extractor', label: 'Extractor'},
];

export default function Navbar() {
  const path = usePathname();

  return (
    <nav className="navbar">
      <div className="page-wrap navbar__inner">
        <Link href="/" className="navbar__logo" id="nav-logo">
          <span className="navbar__logo-icon">🎬</span>
          Reel Pipeline
        </Link>

        <div className="navbar__nav">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              id={`nav-${label.toLowerCase()}`}
              className={`navbar__link${path === href ? ' navbar__link--active' : ''}`}
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="navbar__spacer" />

        <a
          href="https://app.inngest.com"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn--ghost btn--sm"
          id="nav-inngest"
        >
          Inngest ↗
        </a>
      </div>
    </nav>
  );
}
