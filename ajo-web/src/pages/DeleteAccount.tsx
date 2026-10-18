import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import InfoPageLayout from '../components/InfoPageLayout';

const deletionEmail =
  'mailto:theccajo@gmail.com?subject=Account%20deletion%20request&body=Please%20help%20me%20delete%20my%20CC-AJO%20account.%0A%0ARegistered%20phone%20number%20or%20email%3A%20';

export default function DeleteAccount() {
  useEffect(() => {
    document.title = 'Delete Account | CC-ÀJỌ';
  }, []);

  return (
    <InfoPageLayout
      eyebrow="Your account"
      title="Delete Account"
      intro="Here’s how to ask CC-ÀJỌ to delete your account and what to expect from the request."
    >
      <section>
        <h2>Request account deletion</h2>
        <p>
          Account deletion is not yet available as a self-service feature in the app.
          To request deletion, email our support team from the email address associated
          with your account, or include the phone number registered to the account.
        </p>
        <p>
          <a className="btn-sunrise mt-3 !no-underline" href={deletionEmail}>
            Email an account deletion request
          </a>
        </p>
        <p>
          You can also write directly to{' '}
          <a href="mailto:theccajo@gmail.com?subject=Account%20deletion%20request">
            theccajo@gmail.com
          </a>{' '}
          with the subject “Account deletion request”.
        </p>
      </section>

      <section>
        <h2>What to include</h2>
        <ul>
          <li>The phone number or email address registered to your CC-ÀJỌ account.</li>
          <li>A short statement that you want your account deleted.</li>
          <li>
            If you can no longer access that contact address, explain that in your
            message so support can advise you on identity verification.
          </li>
        </ul>
        <p>
          Never send your password, PIN, one-time code, bank password or full card
          details by email.
        </p>
      </section>

      <section>
        <h2>What happens next</h2>
        <p>
          A support team member will review the request and may ask you to verify that
          you own the account before taking action. Sending an email does not itself
          immediately delete or disable an account; the request currently requires
          manual handling.
        </p>
        <p>
          Some group and financial history may need to remain available to other
          members so they can understand past contributions, payments and disputes.
          Support will explain any records that cannot be removed as part of your
          request. Specific deletion and retention periods are still being finalized.
        </p>
      </section>

      <section>
        <h2>Need help?</h2>
        <p>
          For questions about your request, email{' '}
          <a href="mailto:theccajo@gmail.com">theccajo@gmail.com</a>. Read the{' '}
          <Link to="/privacy-policy">Privacy Policy</Link> for information about account
          data and group records.
        </p>
      </section>
    </InfoPageLayout>
  );
}
