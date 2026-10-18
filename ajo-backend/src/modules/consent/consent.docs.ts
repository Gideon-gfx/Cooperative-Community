import { ConsentDocType } from '@prisma/client';

// English originals. These are PLACEHOLDERS: every document starts with the DRAFT line and must be reviewed and
// approved by a qualified Nigerian lawyer before real use. They state facts about how the app works and make no
// legal claims and cite no statutes.
export const DRAFT_LINE = '[DRAFT - REQUIRES REVIEW BY A QUALIFIED NIGERIAN LAWYER BEFORE USE]';

const MEMBER_DISCLOSURE = `${DRAFT_LINE}

# Paying your group's collector directly

## 1. What this means
Your group has chosen **collector custody**. When you pay your contribution, you pay it **directly into the bank account of your group's collector**. The collector holds the money. CC-ÀJỌ does **not** hold it.

## 2. What CC-ÀJỌ does
CC-ÀJỌ records each payment, shows it to the group, sends reminders and receipts, and lets you raise a dispute. CC-ÀJỌ only records and verifies. It does not move or keep your money.

## 3. What CC-ÀJỌ does not do
CC-ÀJỌ does **not guarantee** your money. CC-ÀJỌ does not promise that you will get your money back or receive a payout.

## 4. The risks
Because the collector holds the money, you could lose some or all of it if the collector makes a mistake, is dishonest, runs into money trouble, or cannot pay. You accept this risk when you choose collector custody.

## 5. Escrow is available
Your group can use **escrow** instead. With escrow, contributions go through our payment partner and are only released after the required approvals. Escrow is the **recommended** option. You can ask your collector or group admin to use escrow.

## 6. Fees and commission
You will see every fee before you pay: the platform fee, the collector fee, any transport cost and any gateway fee. The platform fee is shown on your receipt.

## 7. If something goes wrong
You can raise a dispute in the app. Your collector, the platform admins and the Community Trust Board are told. A note is written when it is resolved, and the history is kept.

## 8. Your choice
Signing is **voluntary**. You can withdraw your consent between cycles. If you do not sign, you cannot pay into a collector-custody group.

## 9. Governing law
[GOVERNING LAW AND COURT - TO BE COMPLETED BY THE GROUP'S LAWYER]
`;

const COLLECTOR_AGREEMENT = `${DRAFT_LINE}

# Collector agreement

## 1. What I am agreeing to
I will hold my group's contributions in my own bank account as the group's collector. I understand that CC-ÀJỌ does **not** hold, guarantee or insure this money and only records and verifies it.

## 2. What I promise
- I will keep the group's money in a **separate account** and will **not mix it** with my own money or any other money.
- I will **confirm or dispute** each payment quickly, within 48 hours.
- I will keep honest records and tell members the truth about the balance.
- I will pay out recipients on time and record every payout.
- I will **cooperate** with any dispute, review or request for records.

## 3. Risks
Members trust me with their money. If I lose it or fail to pay, members can lose their savings, and I may be responsible to them.

## 4. Escrow is available and recommended
I understand that **escrow** is available to my group and is the recommended option, and that I may be asked to move my group to escrow.

## 5. Limits
I understand my group and I have limits on how much money can be held in custody, and that these limits depend on my verification level.

## 6. Fees and commission
I understand the platform commission and fees, and that I may be invoiced for commission on completed cycles.

## 7. Disputes
I understand that disputes are recorded, shared with the platform admins and the Community Trust Board, and kept in the group's history.

## 8. My choice
I sign **voluntarily**. I can ask to stop being a custody collector between cycles.

## 9. Governing law
[GOVERNING LAW AND COURT - TO BE COMPLETED BY THE LAWYER]
`;

const PLATFORM_TERMS = `${DRAFT_LINE}

# CC-ÀJỌ terms of use

## 1. What CC-ÀJỌ is
CC-ÀJỌ helps community groups save together, buy food together and support each other. It records contributions, shows them to the group and keeps receipts.

## 2. Your money
In **escrow** groups, your contribution is collected through our payment partner and is only released after the required approvals. In **collector custody** groups, you pay your collector directly and CC-ÀJỌ does not hold the money. Your group's screen always shows which one applies.

## 3. No guarantee
CC-ÀJỌ does not guarantee payouts, savings, or the honesty of any member or collector.

## 4. Fees
Fees and commission are shown to you before you pay and on your receipt.

## 5. Your information
We keep the records needed to run your group and to show it to your group. [PRIVACY AND DATA PROTECTION NOTICE - TO BE COMPLETED BY THE LAWYER]

## 6. Your choice
You agree voluntarily. You can stop using the app at any time, but your past records are kept so your group's history stays complete.

## 7. Governing law
[GOVERNING LAW AND COURT - TO BE COMPLETED BY THE LAWYER]
`;

export const SEED_DOCUMENTS: Record<ConsentDocType, string> = {
  CUSTODY_MEMBER_DISCLOSURE: MEMBER_DISCLOSURE,
  CUSTODY_COLLECTOR_AGREEMENT: COLLECTOR_AGREEMENT,
  PLATFORM_TERMS,
};

/** Which documents need the 3-question comprehension check before the sign button works. */
export const NEEDS_COMPREHENSION: Record<ConsentDocType, boolean> = {
  CUSTODY_MEMBER_DISCLOSURE: true,
  CUSTODY_COLLECTOR_AGREEMENT: true,
  PLATFORM_TERMS: false,
};

// Interface strings. Questions keep their option ORDER in every language, so answers are graded by index.
export const UI_STRINGS = {
  draftBanner: 'DRAFT: this text has not been approved by a lawyer yet.',
  machineBanner: 'This is an unofficial translation to help you understand. The controlling version is {original}.',
  viewOriginal: 'See the original',
  sideBySide: 'Show side by side',
  listen: 'Listen',
  witnessNote: 'A witness is recommended for this language.',
  witnessRequired: 'We cannot show this in your language. Please ask a witness to read it to you and sign with them.',
  audioFallback: 'Reading aloud is not available in this language. A witness can read it to you.',
  questionsTitle: 'Check that you understand',
  questions: [
    { q: 'Who holds your money?', options: ["Your group's collector", 'CC-ÀJỌ', 'A bank holds it for you'] },
    { q: 'Does CC-ÀJỌ guarantee your money?', options: ['Yes', 'No'] },
    { q: 'Can you choose escrow instead?', options: ['Yes', 'No'] },
  ],
  signButton: 'I agree and sign',
  typedNameLabel: 'Type your full name',
  otpLabel: 'Code we sent to your phone',
  witnessTitle: 'Signing with a witness',
  witnessExplained: 'I explained this document and the person understood.',
  thankYou: 'Thank you. Your signed receipt has been sent.',
} as const;

/** The right answers by question index: the collector holds it; CC-ÀJỌ does not guarantee it; escrow is a choice. */
export const CORRECT_ANSWERS = [0, 1, 0] as const;

export const AUDIO_SCRIPT_KEYS = ['questionsTitle', 'signButton'] as const;
