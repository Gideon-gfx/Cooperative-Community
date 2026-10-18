import { useEffect } from 'react';
import InfoPageLayout from '../components/InfoPageLayout';

export default function PrivacyPolicy() {
  useEffect(() => {
    document.title = 'Privacy Policy | CC-ÀJỌ';
  }, []);

  return (
    <InfoPageLayout
      eyebrow="Your information"
      title="Privacy Policy"
      intro="How CC-ÀJỌ uses information to help communities organise savings, food buying and shared records."
      draftNotice
    >
      <p className="text-sm font-semibold text-cocoa-muted">Last updated: October 18, 2026</p>

      <section>
        <h2>1. About this policy</h2>
        <p>
          CC-ÀJỌ provides tools for community groups to coordinate contributions, savings
          rotations, food pools, communications and records. This draft explains the
          information the current product can process. It needs qualified legal review
          before it is treated as the co-operative’s final privacy policy.
        </p>
      </section>

      <section>
        <h2>2. Information the service may process</h2>
        <ul>
          <li>
            <strong>Account and profile details:</strong> your name, phone number or email
            address, account role, preferred language, country, date of birth if provided,
            referral details, and PIN or password verification data.
          </li>
          <li>
            <strong>Group and activity records:</strong> group memberships, messages,
            contributions, payment confirmations, receipts, payout and food-pool activity,
            votes, disputes, and other records needed to operate a group.
          </li>
          <li>
            <strong>Payment and collector details:</strong> payment references, amounts,
            payment status, fees shown to you, and bank account details supplied by a
            collector. The app does not ask for your bank password or card PIN.
          </li>
          <li>
            <strong>Optional information:</strong> location and location label when a
            collector or transporter chooses to provide them, and documents, images or
            other files uploaded by a user.
          </li>
          <li>
            <strong>Security and consent records:</strong> login and verification events,
            signed consent records, typed names, signature or witness details, and the
            device/browser information and IP address recorded when a consent is signed.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. How we use information</h2>
        <p>
          Information is used to create and secure accounts; operate groups, savings
          rotations and food pools; show ledgers and receipts; send authentication codes,
          reminders and service messages; verify or investigate payment and dispute
          records; support users; and protect the service from misuse.
        </p>
      </section>

      <section>
        <h2>4. What group members can see</h2>
        <p>
          CC-ÀJỌ is a shared community service. People in a group may see the profile and
          group activity needed to participate, such as member names, contributions,
          payment status, receipts and group messages. Please do not post information in
          a group that you do not want its members to see.
        </p>
      </section>

      <section>
        <h2>5. Money handling and service providers</h2>
        <p>
          The group’s selected funds mode determines how contributions are handled. In
          collector-custody groups, members pay the collector directly and CC-ÀJỌ records
          the activity; the platform does not hold or move those funds. In escrow groups,
          a payment partner processes funds subject to that group’s flow. Payment,
          messaging, hosting and other technical providers may process information needed
          to provide their services.
        </p>
      </section>

      <section>
        <h2>6. Browser storage and device permissions</h2>
        <p>
          The web app stores your sign-in token and basic profile in browser local storage
          so you can remain signed in, and saves your cookie choice in local storage.
          Essential storage remains active so the service can work. CC-ÀJỌ does not
          currently use optional analytics or advertising cookies. The mobile app may ask
          for location or photo-library access when you choose a feature that needs it;
          you can manage those permissions in your device settings.
        </p>
      </section>

      <section>
        <h2>7. Retention and account deletion</h2>
        <p>
          The service keeps group and financial history so members can understand past
          activity. Specific retention periods and the treatment of records after an
          account deletion request require legal review. There is no automatic account
          deletion feature at this time. To request account deletion, email{' '}
          <a href="mailto:theccajo@gmail.com?subject=Account%20deletion%20request">
            theccajo@gmail.com
          </a>
          . We may need to verify your identity and explain which records must remain in
          group history.
        </p>
      </section>

      <section>
        <h2>8. Your requests and contact</h2>
        <p>
          For a privacy question or a request to access, correct or delete account
          information, contact{' '}
          <a href="mailto:theccajo@gmail.com">theccajo@gmail.com</a> from the email
          address associated with your account, or include your registered phone number.
          Do not email your password, PIN or one-time verification code.
        </p>
      </section>
    </InfoPageLayout>
  );
}
