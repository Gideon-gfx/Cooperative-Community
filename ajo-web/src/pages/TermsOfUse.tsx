import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import InfoPageLayout from '../components/InfoPageLayout';

export default function TermsOfUse() {
  useEffect(() => {
    document.title = 'Terms of Use | CC-ÀJỌ';
  }, []);

  return (
    <InfoPageLayout
      eyebrow="Using CC-ÀJỌ"
      title="Terms of Use"
      intro="A plain-language overview of the service and the responsibilities involved in using it."
      draftNotice
    >
      <p className="text-sm font-semibold text-cocoa-muted">Last updated: October 18, 2026</p>

      <section>
        <h2>1. About the service</h2>
        <p>
          CC-ÀJỌ provides digital tools for communities to organise group savings, food
          buying and shared records. The service can record contributions, display
          receipts and ledgers, and send group updates. It does not replace the agreements
          members make with each other.
        </p>
      </section>

      <section>
        <h2>2. Your account and responsibilities</h2>
        <p>
          Keep your sign-in details private and provide accurate information when using
          the service. You are responsible for activity carried out through your account.
          Use the service lawfully, respectfully, and only for groups and transactions
          that you are authorised to participate in.
        </p>
      </section>

      <section>
        <h2>3. Groups, contributions and payment modes</h2>
        <p>
          Each group should explain its rules, contribution schedule, fees and payout
          arrangements to its members. The group’s screen identifies its funds mode:
        </p>
        <ul>
          <li>
            <strong>Collector custody:</strong> you pay the group’s collector directly.
            The collector holds the money. CC-ÀJỌ records and displays activity but does
            not hold, move, guarantee or insure those funds.
          </li>
          <li>
            <strong>Escrow:</strong> a payment partner processes contributions and
            releases them according to the group’s required approvals and payment flow.
          </li>
        </ul>
        <p>
          Check the group’s terms and confirm the payment mode before contributing.
          Payment references and in-app records help document activity but do not by
          themselves guarantee a payout or resolve every dispute.
        </p>
      </section>

      <section>
        <h2>4. Fees and third parties</h2>
        <p>
          Applicable platform, collector, transport and payment-processing fees are shown
          in the relevant flow or receipt. Payment and messaging features may rely on
          third-party providers, whose services have their own terms and privacy
          information.
        </p>
      </section>

      <section>
        <h2>5. Records and disputes</h2>
        <p>
          Keep your own important receipts and group agreements. CC-ÀJỌ provides shared
          records and dispute tools, but does not promise that every record is complete,
          that every dispute will have a particular outcome, or that a group member or
          collector will perform as expected.
        </p>
      </section>

      <section>
        <h2>6. Availability and changes</h2>
        <p>
          We may update or temporarily suspend features to maintain or improve the
          service. Keep contact details current so important account and group messages
          can reach you.
        </p>
      </section>

      <section>
        <h2>7. Closing your account and questions</h2>
        <p>
          You may stop using the service at any time. Account deletion requests are
          currently handled manually; visit the{' '}
          <Link to="/delete-account">Delete Account page</Link> for instructions. Some group
          history may need to remain available so past financial activity is clear to
          other members.
        </p>
        <p>
          Questions about these terms can be sent to{' '}
          <a href="mailto:theccajo@gmail.com">theccajo@gmail.com</a>.
        </p>
      </section>

      <section>
        <h2>8. Governing law</h2>
        <p>
          The governing-law and dispute-resolution terms have not yet been completed.
          This section must be reviewed and completed by a qualified Nigerian lawyer
          before publication as a final agreement.
        </p>
      </section>
    </InfoPageLayout>
  );
}
