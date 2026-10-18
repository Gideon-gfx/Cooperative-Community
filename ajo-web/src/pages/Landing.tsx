import {
  ArrowDown,
  Check,
  HandCoins,
  ShieldCheck,
  ShoppingBasket,
  UsersRound,
} from 'lucide-react';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';

const appStoreUrl = 'https://apps.apple.com/search?term=Ajo%20Community';
const playStoreUrl = 'https://play.google.com/store/search?q=Ajo%20Community&c=apps';

const waysToGrow = [
  {
    icon: HandCoins,
    title: 'Save together',
    description:
      'Bring your circle together for rotational savings. Keep track of contributions, turns and receipts in one shared place.',
    className: 'bg-primary-light text-primary',
  },
  {
    icon: ShoppingBasket,
    title: 'Buy together',
    description:
      'Pool orders with your community and buy food factory-direct. See contributions, orders and collection details clearly.',
    className: 'bg-accent-light text-cocoa',
  },
];

const steps = [
  {
    number: '01',
    title: 'Find your people',
    description: 'Start with a trusted circle, neighbourhood or co-operative.',
  },
  {
    number: '02',
    title: 'Agree on a plan',
    description: 'Choose a savings or food pool and make the details clear to everyone.',
  },
  {
    number: '03',
    title: 'Keep everyone in the loop',
    description: 'Follow contributions, receipts and updates together in ÀJỌ.',
  },
];

function StoreButton({
  href,
  store,
  badgeSrc,
}: {
  href: string;
  store: string;
  badgeSrc: string;
}) {
  return (
    <a
      className="store-button"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Download ÀJỌ on the ${store}`}
    >
      <img className="store-badge" src={badgeSrc} alt="" />
    </a>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen overflow-hidden bg-cream text-cocoa">
      <SiteHeader />

      <main>
        <section id="home" className="relative">
          <div className="pointer-events-none absolute -right-36 top-4 h-96 w-96 rounded-full bg-accent-light blur-3xl" />
          <div className="pointer-events-none absolute -left-36 bottom-0 h-80 w-80 rounded-full bg-primary-light blur-3xl" />
          <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 px-5 pb-20 pt-12 sm:px-8 sm:pb-28 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-12 lg:pt-24">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-card px-4 py-2 text-sm font-semibold text-cocoa shadow-sm">
                <span className="h-2 w-2 rounded-full bg-accent" />
                Community is our greatest asset
              </div>
              <h1 className="max-w-2xl text-5xl font-extrabold leading-[1.08] tracking-tight text-cocoa sm:text-6xl lg:text-7xl">
                Good things grow when we{' '}
                <span className="bg-gradient-to-r from-primary to-gold bg-clip-text text-transparent">pool together.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-cocoa-muted sm:text-xl">
                ÀJỌ helps communities organise trusted group savings and food buying—with
                shared records that keep everyone informed.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <StoreButton href={appStoreUrl} store="App Store" badgeSrc="/app-store-badge.svg" />
                <StoreButton href={playStoreUrl} store="Google Play" badgeSrc="/google-play-badge.png" />
              </div>
              <a
                href="#about"
                className="mt-8 inline-flex min-h-tap items-center gap-2 text-sm font-semibold text-cocoa-muted transition hover:text-primary"
              >
                Discover ÀJỌ <ArrowDown size={16} aria-hidden="true" />
              </a>
            </div>

            <div className="relative mx-auto w-full max-w-lg">
              <div className="absolute -right-3 top-10 h-24 w-24 rounded-3xl bg-accent sm:-right-5" />
              <div className="absolute -bottom-5 -left-4 h-28 w-28 rounded-full bg-primary-light" />
              <div className="relative rounded-[2rem] border border-white/70 bg-card p-5 shadow-[0_28px_80px_-32px_rgba(42,23,18,0.28)] sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-cocoa-muted">YOUR COMMUNITY</p>
                    <h2 className="mt-1 text-2xl font-extrabold text-cocoa">Together, steadily.</h2>
                  </div>
                  <div className="flex -space-x-2" aria-label="Community members">
                    {['bg-primary', 'bg-zobo', 'bg-indigo', 'bg-cocoa'].map((color, index) => (
                      <span
                        key={color}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border-2 border-white ${color} text-xs font-bold text-white`}
                        aria-hidden="true"
                      >
                        {['A', 'K', 'M', '＋'][index]}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-7 rounded-2xl bg-cocoa-night p-5 text-cream sm:p-6">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-cream/75">A little adds up</span>
                    <UsersRound size={19} className="text-gold" aria-hidden="true" />
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <span className="text-3xl font-extrabold tracking-tight sm:text-4xl">As a team</span>
                    <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-gold">
                      Shared goals
                    </span>
                  </div>
                  <div className="mt-6 flex h-14 items-end gap-2" aria-hidden="true">
                    {[35, 52, 42, 70, 57, 84, 68, 100, 78, 91, 72, 100].map((height, index) => (
                      <span
                        key={`${height}-${index}`}
                        className="flex-1 rounded-t-md bg-gradient-to-t from-primary to-gold"
                        style={{ height: `${height}%`, opacity: 0.42 + index * 0.05 }}
                      />
                    ))}
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="flex items-center gap-3 rounded-xl bg-cream p-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-light text-primary-dark">
                      <HandCoins size={20} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-cocoa">Rotational savings</span>
                      <span className="mt-0.5 block text-sm text-cocoa-muted">Clear turns. Shared records.</span>
                    </span>
                    <Check size={18} className="text-primary" aria-hidden="true" />
                  </div>
                  <div className="flex items-center gap-3 rounded-xl bg-cream p-4">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-light text-primary">
                      <ShoppingBasket size={20} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-cocoa">Community food pools</span>
                      <span className="mt-0.5 block text-sm text-cocoa-muted">Plan purchases as a group.</span>
                    </span>
                    <Check size={18} className="text-primary" aria-hidden="true" />
                  </div>
                </div>
              </div>
              <div className="absolute -left-8 top-1/2 hidden -translate-y-1/2 items-center gap-3 rounded-2xl bg-card px-4 py-3 shadow-xl sm:flex">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-light text-primary-dark">
                  <ShieldCheck size={21} aria-hidden="true" />
                </span>
                <span className="text-sm font-bold text-cocoa">Transparent by design</span>
              </div>
            </div>
          </div>
        </section>

        <section id="about" className="bg-card py-20 sm:py-24">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-12">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">A co-operative way forward</p>
              <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-cocoa sm:text-5xl">
                Built around how communities already thrive.
              </h2>
              <p className="mt-5 text-lg leading-8 text-cocoa-muted">
                ÀJỌ brings familiar community practices into one simple place, helping
                groups coordinate, build trust and make progress together.
              </p>
            </div>
            <div className="mt-12 grid gap-5 md:grid-cols-2">
              {waysToGrow.map(({ icon: Icon, title, description, className }) => (
                <article key={title} className="rounded-3xl border border-[#E8D5C0] bg-cream p-7 sm:p-9">
                  <span className={`flex h-14 w-14 items-center justify-center rounded-2xl ${className}`}>
                    <Icon size={27} aria-hidden="true" />
                  </span>
                  <h3 className="mt-6 text-2xl font-extrabold text-cocoa">{title}</h3>
                  <p className="mt-3 max-w-lg text-base leading-7 text-cocoa-muted">{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="bg-cream py-20 sm:py-24">
          <div className="mx-auto grid w-full max-w-7xl gap-12 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20 lg:px-12">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-primary">Simple by design</p>
              <h2 className="mt-4 max-w-lg text-3xl font-extrabold tracking-tight text-cocoa sm:text-5xl">
                Stronger together, one step at a time.
              </h2>
              <p className="mt-5 max-w-lg text-lg leading-8 text-cocoa-muted">
                Get your group on the same page, from the first plan to every update along the way.
              </p>
            </div>
            <div className="space-y-4">
              {steps.map(({ number, title, description }) => (
                <article key={number} className="flex gap-5 rounded-2xl border border-[#E8D5C0] bg-card p-5 shadow-sm sm:gap-6 sm:p-6">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-extrabold text-white">
                    {number}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-cocoa">{title}</h3>
                    <p className="mt-1 leading-6 text-cocoa-muted">{description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="trust" className="bg-cocoa-night py-20 text-cream sm:py-24">
          <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-5 sm:px-8 lg:grid-cols-[auto_1fr] lg:gap-14 lg:px-12">
            <span className="mx-auto flex h-24 w-24 items-center justify-center rounded-[2rem] bg-leaf/20 text-gold sm:h-28 sm:w-28">
              <ShieldCheck size={48} aria-hidden="true" />
            </span>
            <div className="max-w-3xl text-center lg:text-left">
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-gold">Trust &amp; transparency</p>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-cream sm:text-4xl">
                Your money stays with your group.
              </h2>
              <p className="mt-4 text-lg leading-8 text-cream/80">
                ÀJỌ helps record, verify and show payments, receipts and collector statements.
                The platform does not hold or move customer funds—the group’s chosen collector
                holds the money.
              </p>
              <span className="mt-6 inline-flex items-center gap-2 rounded-full border border-leaf/50 bg-leaf/15 px-4 py-2 text-sm font-semibold text-[#A9E4BC]">
                <Check size={16} aria-hidden="true" />
                Shared records. Clear responsibilities.
              </span>
            </div>
          </div>
        </section>

        <section id="download" className="bg-cream px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-cocoa-night px-6 py-12 text-center text-cream sm:px-12 sm:py-16">
            <div className="mx-auto max-w-2xl">
              <img
                className="mx-auto h-14 w-14 rounded-xl"
                src="/ajo-logo.png"
                alt=""
                aria-hidden="true"
              />
              <h2 className="mt-5 text-3xl font-extrabold tracking-tight sm:text-5xl">
                Make more possible, together.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-cream/80">
                Bring your community closer to its shared goals with ÀJỌ.
              </p>
              <div className="mx-auto mt-8 flex max-w-xl flex-col justify-center gap-3 sm:flex-row">
                <StoreButton href={appStoreUrl} store="App Store" badgeSrc="/app-store-badge.svg" />
                <StoreButton href={playStoreUrl} store="Google Play" badgeSrc="/google-play-badge.png" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
