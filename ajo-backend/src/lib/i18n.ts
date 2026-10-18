export type Lang = 'EN' | 'PCM' | 'YO' | 'HA' | 'IG';

type Dict = Record<string, string>;

// NOTE: PCM (Nigerian Pidgin) is reasonably standard. YO / HA / IG are DRAFT translations and must be
// reviewed by native speakers before launch. Keep sentences short: they are read aloud and sent by SMS.
const EN: Dict = {
  'records.verify': 'ÀJỌ: {group} added old records that say you {summary}. Open the app to confirm they are right, or tell us if they are wrong.',
  'ussd.welcome': 'ÀJỌ',
  'ussd.menu': '1. Next payment\n2. My turn\n3. I have paid\n4. Pool funds\n5. Language\n6. Change PIN',
  'ussd.notRegistered': 'You are not registered. Ask your Baba Àlàjọ to add you.',
  'ussd.enterPin': 'Enter your 4-digit PIN:',
  'ussd.wrongPin': 'Wrong PIN. Try again later.',
  'ussd.noDue': 'You have no payment due. Thank you!',
  'ussd.nextDue': 'Pay {amount} to your collector by {date} for {pool}.',
  'ussd.noTurn': 'You have no collection turn coming.',
  'ussd.turn': 'You collect {amount} on {date} in {pool}.',
  'ussd.pickPay': 'Which payment?',
  'ussd.payMethod': 'How did you pay?\n1. Transfer\n2. Cash',
  'ussd.paid': 'Recorded. Your collector will confirm it.',
  'ussd.funds': '{pool}: collector holds {held}. Paid in: {inn}. Paid out: {out}.',
  'ussd.noPools': 'You are not in any pool.',
  'ussd.pickLang': 'Language:\n1. English\n2. Pidgin\n3. Yorùbá\n4. Hausa\n5. Igbo',
  'ussd.langSet': 'Language saved.',
  'ussd.newPin': 'Choose a new 4-digit PIN:',
  'ussd.pinSet': 'PIN saved.',
  'ussd.badInput': 'Invalid choice.',
  'ussd.tempPin': 'Enter the temporary PIN from your SMS:',
  'sms.help': 'ÀJỌ commands: BAL, TURN, FUNDS, PAID <PIN>, LANG <EN|PCM|YO|HA|IG>',
  'remind.soon': 'Reminder: your Àjọ payment of {amount} for {recipient} is due in 2 days.',
  'remind.today': 'TODAY: your Àjọ payment of {amount} is due today. Pay your collector.',
  'digest.line': '{pool}: collector holds {held}. {paid}/{total} paid this cycle. Next payout: {next}.',
};

const PCM: Dict = {
  'records.verify': 'ÀJỌ: {group} add old record wey talk say you {summary}. Open the app confirm say e correct, or tell us if e no correct.',
  'ussd.notRegistered': 'We no see your number. Ask your Baba Àlàjọ make e add you.',
  'ussd.enterPin': 'Put your 4-digit PIN:',
  'ussd.wrongPin': 'Wrong PIN. Try again later.',
  'ussd.noDue': 'You no get any money to pay now. Thank you!',
  'ussd.nextDue': 'Pay {amount} to your collector before {date} for {pool}.',
  'ussd.noTurn': 'Your collection turn never reach.',
  'ussd.turn': 'You go collect {amount} on {date} for {pool}.',
  'ussd.pickPay': 'Which payment?',
  'ussd.payMethod': 'How you pay?\n1. Transfer\n2. Cash',
  'ussd.paid': 'We don note am. Your collector go confirm.',
  'ussd.funds': '{pool}: collector get {held}. Wey enter: {inn}. Wey comot: {out}.',
  'ussd.noPools': 'You no dey any pool.',
  'ussd.langSet': 'We don save your language.',
  'ussd.newPin': 'Choose new 4-digit PIN:',
  'ussd.pinSet': 'PIN don save.',
  'ussd.badInput': 'Wrong choice.',
  'ussd.tempPin': 'Put the temporary PIN wey we send you:',
  'remind.soon': 'Reminder: your Àjọ money of {amount} for {recipient} go due in 2 days.',
  'remind.today': 'TODAY: your Àjọ money of {amount} don due. Pay your collector.',
};

const YO: Dict = {
  'records.verify': 'ÀJỌ: {group} fi àkọsílẹ̀ àtijọ́ kún un tí ó sọ pé o {summary}. Ṣí app náà láti jẹ́rìí sí i pé ó tọ̀nà, tàbí sọ fún wa tí kò bá tọ̀nà.',
  'ussd.notRegistered': 'A kò rí nọ́mbà rẹ. Bẹ Baba Àlàjọ rẹ kó fi ọ́ kún un.',
  'ussd.enterPin': 'Tẹ PIN oní-nọ́mbà mẹ́rin rẹ:',
  'ussd.wrongPin': 'PIN kò tọ́. Gbìyànjú lẹ́yìn náà.',
  'ussd.noDue': 'O kò ní owó láti san báyìí. A dúpẹ́!',
  'ussd.nextDue': 'San {amount} fún olùgbà owó rẹ ní ọjọ́ {date} fún {pool}.',
  'ussd.noTurn': 'Àkókò rẹ láti gba owó kò tíì dé.',
  'ussd.turn': 'Ìwọ yóò gba {amount} ní ọjọ́ {date} ní {pool}.',
  'ussd.paid': 'A ti kọ ọ́ sílẹ̀. Olùgbà owó rẹ yóò jẹ́rìí rẹ̀.',
  'ussd.langSet': 'A ti fi èdè rẹ pamọ́.',
  'ussd.pinSet': 'A ti fi PIN pamọ́.',
  'remind.soon': 'Ìránnilétí: owó Àjọ rẹ {amount} fún {recipient} yóò tó san ní ọjọ́ méjì.',
  'remind.today': 'LÓNÌÍ: owó Àjọ rẹ {amount} tó san lónìí. San fún olùgbà owó rẹ.',
};

const HA: Dict = {
  'ussd.notRegistered': 'Ba mu ga lambarka ba. Ka tambayi Baba Àlàjọ ɗinka ya saka ka.',
  'ussd.enterPin': 'Shigar da PIN ɗinka mai lamba 4:',
  'ussd.wrongPin': 'PIN ɗin ba daidai ba ne. Sake gwadawa daga baya.',
  'ussd.noDue': 'Ba ka da kuɗin da za ka biya yanzu. Na gode!',
  'ussd.nextDue': 'Biya {amount} ga mai karɓa kafin {date} don {pool}.',
  'ussd.noTurn': 'Lokacin karɓarka bai zo ba tukuna.',
  'ussd.turn': 'Za ka karɓi {amount} ranar {date} a {pool}.',
  'ussd.paid': 'An rubuta. Mai karɓa zai tabbatar.',
  'ussd.langSet': 'An adana harshenka.',
  'ussd.pinSet': 'An adana PIN.',
  'remind.soon': 'Tunatarwa: kuɗin Àjọ {amount} na {recipient} zai kai lokaci cikin kwanaki 2.',
  'remind.today': 'YAU: kuɗin Àjọ {amount} ya kai lokaci. Biya mai karɓa.',
};

const IG: Dict = {
  'ussd.notRegistered': 'Anyị adịghị ahụ nọmba gị. Gwa Baba Àlàjọ gị ka o tinye gị.',
  'ussd.enterPin': 'Tinye PIN gị nwere ọnụ ọgụgụ anọ:',
  'ussd.wrongPin': 'PIN ezighi ezi. Nwaa ọzọ mgbe e mesịrị.',
  'ussd.noDue': 'Ị enweghị ego ị ga-akwụ ugbu a. Daalụ!',
  'ussd.nextDue': 'Kwụọ {amount} onye na-anara ego tupu {date} maka {pool}.',
  'ussd.noTurn': 'Oge gị iji nata ego erubeghị.',
  'ussd.turn': 'Ị ga-anata {amount} na {date} na {pool}.',
  'ussd.paid': 'Edeela ya. Onye na-anara ego ga-eme nkwenye.',
  'ussd.langSet': 'Echekwara asụsụ gị.',
  'ussd.pinSet': 'Echekwara PIN.',
  'remind.soon': 'Ncheta: ego Àjọ gị {amount} maka {recipient} ga-erute n\'ụbọchị 2.',
  'remind.today': 'TAA: ego Àjọ gị {amount} ruru. Kwụọ onye na-anara ego.',
};

const DICTS: Record<Lang, Dict> = { EN, PCM, YO, HA, IG };

/** Translate with fallback to English, then to the key. `{name}` placeholders are filled from vars. */
export function t(lang: Lang | string | undefined, key: string, vars: Record<string, string | number> = {}): string {
  const dict = DICTS[(lang as Lang) ?? 'EN'] ?? EN;
  const raw = dict[key] ?? EN[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const LANG_CODES: Lang[] = ['EN', 'PCM', 'YO', 'HA', 'IG'];
