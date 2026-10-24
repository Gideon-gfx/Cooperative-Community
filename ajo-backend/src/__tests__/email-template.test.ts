import { brandedEmailHtml, passwordResetEmail, welcomeEmail } from '../lib/email-template';

describe('branded email templates', () => {
  it('includes the hosted brand logo, useful links, and support contact', () => {
    const html = brandedEmailHtml('ÀJỌ account update', 'Your account details changed.');

    expect(html).toContain('https://theccajo.com/ajo-logo.png');
    expect(html).toContain('https://theccajo.com/privacy-policy');
    expect(html).toContain('https://theccajo.com/terms-of-use');
    expect(html).toContain('https://apps.apple.com/search?term=Ajo%20Community');
    expect(html).toContain('https://play.google.com/store/search?q=Ajo%20Community&amp;c=apps');
    expect(html).toContain('theccajo@gmail.com');
  });

  it('renders a personalized welcome with a clear sign-in call to action', () => {
    const welcome = welcomeEmail('Ayo & Co');

    expect(welcome.subject).toContain('Welcome to ÀJỌ');
    expect(welcome.text).toContain('Your ÀJỌ account is ready');
    expect(welcome.html).toContain('Welcome to ÀJỌ, Ayo &amp; Co!');
    expect(welcome.html).toContain('Explore ÀJỌ');
  });

  it('highlights password reset codes and explains expiry and safety', () => {
    const reset = passwordResetEmail('123456');

    expect(reset.text).toContain('expires in 10 minutes');
    expect(reset.html).toContain('>123456</div>');
    expect(reset.html).toContain('Never share');
  });
});
