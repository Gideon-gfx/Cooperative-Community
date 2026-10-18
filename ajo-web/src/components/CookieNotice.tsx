import { useState } from 'react';
import { Cookie } from 'lucide-react';
import { Link } from 'react-router-dom';

const PREFERENCE_KEY = 'cc-ajo-cookie-preference';

type CookieChoice = 'all' | 'accept' | 'reject';

export default function CookieNotice() {
  const [visible, setVisible] = useState(() => localStorage.getItem(PREFERENCE_KEY) === null);

  const choose = (choice: CookieChoice) => {
    localStorage.setItem(PREFERENCE_KEY, choice);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <aside
      className="cookie-notice fixed inset-x-4 bottom-4 z-[110] mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border border-[#E8D5C0] bg-card p-5 shadow-[0_16px_60px_rgba(42,23,18,0.2)] sm:inset-x-6 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:p-6"
      aria-label="Cookie and storage notice"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-light text-primary">
          <Cookie size={21} aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-bold text-cocoa">A note about cookies and storage</h2>
          <p className="mt-1 max-w-xl text-sm leading-6 text-cocoa-muted">
            Essential storage keeps you signed in and saves this choice. We don’t currently
            use optional analytics or advertising cookies. “Accept all” records permission
            for optional cookies; “Accept” and “Reject” keep optional cookies off. Essential
            storage remains active.{' '}
            <Link className="font-semibold text-primary underline underline-offset-2" to="/privacy-policy">
              Privacy details
            </Link>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
        <button
          className="btn-sunrise !min-h-11 !min-w-0 !px-4 !py-2.5 !text-sm"
          type="button"
          onClick={() => choose('all')}
        >
          Accept all
        </button>
        <button
          className="btn-outline !min-h-11 !min-w-0 !px-4 !py-2.5 !text-sm"
          type="button"
          onClick={() => choose('accept')}
        >
          Accept
        </button>
        <button
          className="btn-outline !min-h-11 !min-w-0 !border-cocoa/30 !px-4 !py-2.5 !text-sm !text-cocoa hover:!bg-cream"
          type="button"
          onClick={() => choose('reject')}
        >
          Reject
        </button>
      </div>
    </aside>
  );
}
