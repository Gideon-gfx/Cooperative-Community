import { Children, type ReactNode } from 'react';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import ScrollReveal from './ScrollReveal';

interface InfoPageLayoutProps {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
  draftNotice?: boolean;
}

export default function InfoPageLayout({
  eyebrow,
  title,
  intro,
  children,
  draftNotice = false,
}: InfoPageLayoutProps) {
  return (
    <div className="min-h-screen bg-cream text-cocoa">
      <SiteHeader homePath="/" />

      <main>
        <section className="bg-cocoa-night px-5 py-12 text-cream sm:px-8 sm:py-16 lg:px-12">
          <ScrollReveal>
          <div className="mx-auto max-w-4xl">
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-gold">{eyebrow}</p>
            <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">{title}</h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-cream/80">{intro}</p>
          </div>
          </ScrollReveal>
        </section>

        <section className="px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
          <ScrollReveal>
          <div className="mx-auto max-w-4xl">
            {draftNotice && (
              <aside className="mb-10 rounded-2xl border border-gold/60 bg-accent-light p-5 text-cocoa">
                <h2 className="font-bold">Draft — requires legal review</h2>
                <p className="mt-2 leading-7">
                  This page describes current product behavior and is not legal advice. It
                  has not been approved by a qualified Nigerian lawyer. Please have it
                  reviewed and completed before relying on it as a legal policy.
                </p>
              </aside>
            )}
            <article className="legal-content space-y-9">
              {Children.map(children, (child) => <ScrollReveal>{child}</ScrollReveal>)}
            </article>
          </div>
          </ScrollReveal>
        </section>
      </main>

      <SiteFooter homePath="/" />
    </div>
  );
}
