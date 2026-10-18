import { Link } from 'react-router-dom';

export default function SiteFooter({ homePath = '' }: { homePath?: string }) {
  const homeHref = homePath ? `${homePath}#home` : '#home';

  return (
    <footer className="bg-cocoa-night px-5 py-7 text-cream/75 sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-4 text-sm sm:flex-row">
        <a href={homeHref} className="inline-flex items-center gap-2 font-extrabold tracking-wide text-cream">
          <img className="h-8 w-8 rounded-lg" src="/ajo-logo.png" alt="" aria-hidden="true" />
          CC-ÀJỌ Community Co-operative
        </a>
        <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2" aria-label="Legal">
          <Link className="transition hover:text-gold" to="/privacy-policy">Privacy Policy</Link>
          <Link className="transition hover:text-gold" to="/terms-of-use">Terms of Use</Link>
          <Link className="transition hover:text-gold" to="/delete-account">Delete Account</Link>
        </nav>
        <span>Community savings and buying, made clearer.</span>
      </div>
    </footer>
  );
}
