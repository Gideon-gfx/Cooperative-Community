const SITE_URL = 'https://theccajo.com';
const LOGO_URL = `${SITE_URL}/ajo-logo.png`;
const APP_STORE_URL = 'https://apps.apple.com/search?term=Ajo%20Community';
const PLAY_STORE_URL = 'https://play.google.com/store/search?q=Ajo%20Community&c=apps';
const SUPPORT_EMAIL = 'theccajo@gmail.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface BrandedEmailInput {
  preheader: string;
  title: string;
  paragraphs: string[];
  code?: string;
  actionLabel?: string;
  actionUrl?: string;
}

function renderBrandedEmail(input: BrandedEmailInput): string {
  const paragraphs = input.paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;color:#514338;font-size:15px;line-height:1.65;">${escapeHtml(paragraph)}</p>`)
    .join('');
  const code = input.code
    ? `<div style="margin:24px 0;padding:18px;border:1px solid #ead9b8;border-radius:12px;background:#fff9ed;color:#4b3023;font-family:Arial,sans-serif;font-size:30px;font-weight:700;letter-spacing:8px;text-align:center;">${escapeHtml(input.code)}</div>`
    : '';
  const action = input.actionLabel && input.actionUrl
    ? `<p style="margin:26px 0;text-align:center;"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#a94f2d;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${escapeHtml(input.actionLabel)}</a></p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title></head>
  <body style="margin:0;padding:0;background:#f7f1e6;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f1e6;">
      <tr><td align="center" style="padding:32px 14px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #eadfcd;border-radius:16px;overflow:hidden;">
          <tr><td align="center" style="padding:28px 24px 20px;background:#fffaf1;">
            <a href="${SITE_URL}" style="text-decoration:none;"><img src="${LOGO_URL}" width="88" height="88" alt="CC-ÀJỌ community logo" style="display:block;width:88px;height:88px;object-fit:contain;border:0;"></a>
            <p style="margin:12px 0 0;color:#70482f;font-size:13px;font-weight:700;letter-spacing:2px;">CC-ÀJỌ COMMUNITY CO-OPERATIVE</p>
          </td></tr>
          <tr><td style="padding:30px 32px 22px;">
            <h1 style="margin:0 0 20px;color:#3d2a20;font-size:24px;line-height:1.3;">${escapeHtml(input.title)}</h1>
            ${paragraphs}${code}${action}
            <p style="margin:22px 0 0;color:#76695e;font-size:13px;line-height:1.6;">Need help? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#9b482d;text-decoration:underline;">${SUPPORT_EMAIL}</a>.</p>
          </td></tr>
          <tr><td style="padding:20px 24px;background:#fbf8f2;border-top:1px solid #eee4d6;text-align:center;">
            <p style="margin:0 0 12px;color:#76695e;font-size:12px;line-height:1.7;">
              <a href="${SITE_URL}" style="color:#70482f;">Visit ÀJỌ</a>
              &nbsp;·&nbsp; <a href="${SITE_URL}/privacy-policy" style="color:#70482f;">Privacy</a>
              &nbsp;·&nbsp; <a href="${SITE_URL}/terms-of-use" style="color:#70482f;">Terms</a>
            </p>
            <p style="margin:0;color:#8a7e72;font-size:11px;line-height:1.7;">
              <a href="${escapeHtml(APP_STORE_URL)}" style="color:#70482f;">App Store</a>
              &nbsp;·&nbsp; <a href="${escapeHtml(PLAY_STORE_URL)}" style="color:#70482f;">Google Play</a>
            </p>
            <p style="margin:14px 0 0;color:#a19589;font-size:11px;">© CC-ÀJỌ Community Co-operative</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function brandedEmailHtml(subject: string, text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return renderBrandedEmail({ preheader: text.replace(/\s+/g, ' ').slice(0, 140), title: subject, paragraphs, actionLabel: 'Open ÀJỌ', actionUrl: SITE_URL });
}

export function welcomeEmail(fullName: string): { subject: string; text: string; html: string } {
  const subject = 'Welcome to ÀJỌ — your community, together';
  const text = `Hi ${fullName},\n\nWelcome to CC-ÀJỌ. Your ÀJỌ account is ready. Use the email address and password you registered with to sign in, then join or start a community group.\n\nOpen ÀJỌ: ${SITE_URL}\n\nQuestions? Contact us at ${SUPPORT_EMAIL}.\n\nThe CC-ÀJỌ Team`;
  const html = renderBrandedEmail({
    preheader: 'Your ÀJỌ account is ready. Join your community and get started.',
    title: `Welcome to ÀJỌ${fullName ? `, ${fullName}` : ''}!`,
    paragraphs: [
      'Your account is ready. Use the email address and password you registered with to sign in.',
      'Join or start a community group to save together, buy together, and support one another.',
    ],
    actionLabel: 'Explore ÀJỌ',
    actionUrl: SITE_URL,
  });
  return { subject, text, html };
}

export function passwordResetEmail(code: string): { subject: string; text: string; html: string } {
  const subject = 'Your ÀJỌ password reset code';
  const text = `Your ÀJỌ password reset code is ${code}. It expires in 10 minutes.\n\nIf you did not request this code, you can ignore this email. Never share this code with anyone.\n\nOpen ÀJỌ: ${SITE_URL}\n\nNeed help? ${SUPPORT_EMAIL}`;
  const html = renderBrandedEmail({
    preheader: 'Use this one-time code to reset your ÀJỌ password.',
    title: 'Reset your password',
    paragraphs: [
      'Enter this one-time code in ÀJỌ to continue. It expires in 10 minutes.',
      'If you did not request this code, you can ignore this email. Never share it with anyone.',
    ],
    code,
    actionLabel: 'Open ÀJỌ',
    actionUrl: SITE_URL,
  });
  return { subject, text, html };
}
