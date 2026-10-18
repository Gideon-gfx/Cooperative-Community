import { useEffect, useState } from 'react';
import { ArrowRight, Menu, X } from 'lucide-react';

const navLinks = [
  { label: 'About', href: '#about' },
  { label: 'What you can do', href: '#services' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Trust & transparency', href: '#trust' },
];

export default function SiteHeader({ homePath = '' }: { homePath?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const homeHref = homePath ? `${homePath}#home` : '#home';
  const hrefFor = (href: string) => `${homePath}${href}`;

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  return (
    <header className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
      <a href={homeHref} className="flex items-center gap-3" aria-label="CC-ÀJỌ home">
        <img
          className="h-11 w-11 rounded-xl"
          src="/ajo-logo.png"
          alt=""
          aria-hidden="true"
        />
        <span className="text-xl font-extrabold tracking-tight text-cocoa">CC-ÀJỌ</span>
      </a>
      <nav className="hidden items-center gap-8 text-sm font-semibold text-cocoa-muted min-[813px]:flex">
        {navLinks.map(({ label, href }) => (
          <a key={href} className="transition hover:text-primary" href={hrefFor(href)}>{label}</a>
        ))}
      </nav>
      <div className="flex items-center gap-2">
        <a
          className="btn-sunrise !min-h-11 !min-w-0 !px-5 !py-2.5 !text-sm min-[813px]:inline-flex max-[812px]:hidden"
          href={hrefFor('#download')}
        >
          Get the app <ArrowRight size={16} aria-hidden="true" />
        </a>
        <button
          type="button"
          className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#E8D5C0] text-cocoa transition duration-300 hover:bg-accent-light min-[813px]:hidden ${menuOpen ? 'rotate-90' : ''}`}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={21} aria-hidden="true" /> : <Menu size={21} aria-hidden="true" />}
        </button>
      </div>
      {menuOpen && (
        <div
          id="mobile-navigation"
          className="mobile-menu-overlay fixed inset-0 z-[100] flex min-h-[100dvh] flex-col bg-cream px-6 pb-10 pt-5 sm:px-10 sm:pt-8 min-[813px]:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Main navigation"
        >
          <div className="flex items-center justify-between">
            <a href={homeHref} className="inline-flex items-center gap-3" onClick={() => setMenuOpen(false)}>
              <img className="h-11 w-11 rounded-xl" src="/ajo-logo.png" alt="" aria-hidden="true" />
              <span className="text-xl font-extrabold tracking-tight text-cocoa">CC-ÀJỌ</span>
            </a>
            <button
              type="button"
              className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-[#E8D5C0] text-cocoa transition duration-300 hover:rotate-90 hover:bg-accent-light"
              aria-label="Close navigation menu"
              onClick={() => setMenuOpen(false)}
            >
              <X size={24} aria-hidden="true" />
            </button>
          </div>
          <nav className="mobile-menu-links mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-2" aria-label="Main navigation links">
            {navLinks.map(({ label, href }) => (
              <a
                key={href}
                className="rounded-2xl px-5 py-4 text-2xl font-bold text-cocoa transition hover:bg-accent-light hover:text-primary"
                href={hrefFor(href)}
                onClick={() => setMenuOpen(false)}
              >
                {label}
              </a>
            ))}
            <a
              className="btn-sunrise mt-5 w-full !min-h-14 !justify-between !px-6 !text-lg"
              href={hrefFor('#download')}
              onClick={() => setMenuOpen(false)}
            >
              Get the app <ArrowRight size={20} aria-hidden="true" />
            </a>
          </nav>
          <p className="text-center text-sm font-semibold text-cocoa-muted">Community savings and buying, made clearer.</p>
        </div>
      )}
    </header>
  );
}
