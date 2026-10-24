import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { closeMongoConnection, getMongoDb } from '../src/lib/mongodb';
import { sendEmail } from '../src/lib/mailer';
import { welcomeEmail } from '../src/lib/email-template';

interface WelcomeRecipient {
  email?: string;
  fullName?: string;
  welcomeEmailSentAt?: Date;
}

async function main() {
  const send = process.argv.includes('--send');
  const db = await getMongoDb();
  const users = db.collection<WelcomeRecipient>('User');
  const eligible = { email: { $type: 'string', $ne: '' }, welcomeEmailSentAt: { $exists: false } };
  const count = await users.countDocuments(eligible);

  console.log(`Accounts with email and no welcome-delivery marker: ${count}`);
  if (!send) {
    console.log('Dry run only. Add --send to deliver the welcome email to these accounts.');
    return;
  }

  let sent = 0;
  let failed = 0;
  const cursor = users.find(eligible).project<{ _id: ObjectId; email: string; fullName?: string }>({ email: 1, fullName: 1 });
  for await (const user of cursor) {
    if (!user.email) continue;
    const welcome = welcomeEmail(user.fullName?.trim() || 'there');
    if (!(await sendEmail(user.email, welcome.subject, welcome.text, welcome.html))) {
      failed++;
      continue;
    }
    await users.updateOne(
      { _id: user._id, welcomeEmailSentAt: { $exists: false } },
      { $set: { welcomeEmailSentAt: new Date() } },
    );
    sent++;
  }

  console.log(`Welcome emails accepted: ${sent}; delivery failures: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Welcome email backfill failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(closeMongoConnection);
