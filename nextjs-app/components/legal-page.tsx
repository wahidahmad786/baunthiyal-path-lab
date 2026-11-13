import Link from 'next/link';
import { LegalLinks } from './legal-links';

type Section = { title: string; paragraphs: string[] };
export const LEGAL_PAGES: Record<string, { title: string; intro: string; sections: Section[] }> = {
  'privacy-policy': {
    title: 'Privacy policy',
    intro:
      'This policy explains how Baunthiyal Path Lab handles information provided through its website, diagnostic collection services and WhatsApp communications.',
    sections: [
      {
        title: 'Information we handle',
        paragraphs: [
          'When you sign in with Google, the application uses your account identifier, name, email address and verification status to identify your workspace. We do not receive your Google password.',
          'Customer records can include name, phone number, optional age, customer groups, bookings, test selections, visit information and recorded communication preferences. Where a laboratory service requires medical or report information, access is limited to the relevant service and authorized staff.',
          'WhatsApp records can include message content, sender and recipient identifiers, timestamps, responses, and delivery or read status when provided by Meta. Campaigns can include promotional images and booking requests.',
        ],
      },
      {
        title: 'Why we use information',
        paragraphs: [
          'We use information to provide requested laboratory services, manage bookings and customer records, provide essential service communications, operate your account, answer requests and protect the service.',
          'Promotional WhatsApp campaigns are limited to customers with recorded marketing consent. Marketing consent is separate from essential booking and report notifications. We do not sell personal information.',
        ],
      },
      {
        title: 'WhatsApp and marketing preferences',
        paragraphs: [
          'With your consent, Baunthiyal Path Lab may send health-package offers through the official WhatsApp Business Platform. You can withdraw promotional consent at any time by replying STOP, contacting the lab or using an available preferences link.',
          'If an automated channel is not active, contact the lab directly to update your preference. Staff must record the change before any further promotional outreach. Withdrawing marketing consent does not cancel a requested laboratory service.',
        ],
      },
      {
        title: 'Service providers and international processing',
        paragraphs: [
          'The application uses Google Firebase for authentication and database services, Meta for WhatsApp Business Platform messaging, and Render for the publicly hosted application. Providers process information needed to perform their services under their own applicable terms.',
          'Providers may process information in India and other countries. Firebase database records for this deployment are hosted in Mumbai; application hosting and other provider processing may take place outside India. We share information only as needed for the service, your request, or an applicable legal obligation.',
        ],
      },
      {
        title: 'Security, cookies and access',
        paragraphs: [
          'We use HTTPS, authenticated access and workspace restrictions. Saved WhatsApp credentials are encrypted on the server and are not displayed in public pages. Staff are responsible for using authorized accounts and protecting access.',
          'Sign-in uses essential session cookies and browser authentication storage. Public offer and tracking links are intended to expose offer information, not private patient records. No transmission or storage system can promise absolute security.',
        ],
      },
      {
        title: 'Retention and your choices',
        paragraphs: [
          'We retain information for the purposes described here and applicable laboratory, accounting or legal requirements. Minimal consent and opt-out records may be retained to honor communication preferences. Provider backup retention can differ from active application storage.',
          'You may request access, correction, withdrawal of consent or deletion by contacting Baunthiyal Path Lab. We verify identity before responding to requests involving personal records. Where a record must be retained, we explain the applicable limitation. See the data deletion page for request instructions.',
        ],
      },
      {
        title: 'Children, changes and contact',
        paragraphs: [
          'Parents or guardians should arrange services and provide any necessary consent for children. Promotional consent should be provided by an adult authorized to make that choice.',
          'We may update this policy when our services or requirements change. The date shown on this page identifies the current version. For privacy questions, call or WhatsApp Baunthiyal Path Lab on +91 63959 51791.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of use',
    intro:
      'These terms apply to the Baunthiyal Path Lab website, account workspace, booking requests and promotional offers.',
    sections: [
      {
        title: 'Accounts and authorized use',
        paragraphs: [
          'Use accurate information and access only accounts and records you are authorized to manage. Keep passwords, tokens and account access private. Do not upload unlawful content or use the platform to contact people without the required consent.',
        ],
      },
      {
        title: 'Bookings, tests and offers',
        paragraphs: [
          'A submitted booking request is not a confirmed appointment. The lab confirms test availability, collection arrangements, eligibility and the final payable amount. Offers apply only during their stated validity and under the conditions displayed with the offer.',
          'Test descriptions and website content are informational. They do not replace advice, diagnosis or treatment from a qualified healthcare professional. Contact emergency services for urgent medical needs.',
        ],
      },
      {
        title: 'Payments and cancellations',
        paragraphs: [
          'Applicable charges and any eligible discount must be confirmed by the lab before payment. For cancellations, refunds or payment corrections, contact the lab with the booking or receipt reference. Staff review the request against the service provided and applicable requirements. Do not send card details or banking passwords in WhatsApp messages.',
        ],
      },
      {
        title: 'Communications and availability',
        paragraphs: [
          'Promotional WhatsApp messages require separate marketing consent and may be stopped at any time. Essential service notifications are handled separately. Message availability and delivery depend on the relevant providers and account configuration.',
          'We may maintain or update the service. Use the contact number for assistance when a website function or automated channel is unavailable. The privacy policy explains information handling and your choices.',
        ],
      },
      {
        title: 'Contact and applicable requirements',
        paragraphs: [
          'For account, service or offer queries, contact Baunthiyal Path Lab on +91 63959 51791. These terms operate subject to applicable Indian law and do not limit rights that cannot legally be excluded.',
        ],
      },
    ],
  },
  'data-deletion': {
    title: 'Data deletion instructions',
    intro:
      'You can ask Baunthiyal Path Lab to delete information associated with your customer record or application account.',
    sections: [
      {
        title: '1. Send a deletion request',
        paragraphs: [
          'Call or WhatsApp +91 63959 51791 and state “Data deletion request”. Include the name and registered phone number associated with the record. For an application account, also identify the sign-in email address. Tell us whether the request concerns your application account, customer record, WhatsApp data or another specific record.',
          'Do not send passwords, access tokens, full identity documents or medical reports with the initial request. Staff will explain any verification needed through an appropriate channel.',
        ],
      },
      {
        title: '2. Identity and request review',
        paragraphs: [
          'We verify that the requester is the account or record owner, or an authorized representative, before changing or deleting personal information. Staff review the request, confirm its scope and explain any information that must be retained for an applicable laboratory, accounting or legal requirement.',
        ],
      },
      {
        title: '3. Completion and retained records',
        paragraphs: [
          'After verification and review, we delete or de-identify eligible active records and confirm the outcome through your verified contact channel. Necessary audit, opt-out or legally required records may be retained; provider backups may expire separately under their retention schedules.',
        ],
      },
      {
        title: 'Marketing opt-out and connected accounts',
        paragraphs: [
          'To stop promotional WhatsApp messages, reply STOP or contact the lab and request a marketing opt-out. Opting out stops promotional outreach; it is separate from deleting an account or laboratory record.',
          'Removing an application from your Google or Meta account can revoke connected access, but does not by itself delete records already held by the lab. Use the request procedure above for deletion of those records. These are request instructions, not an automated Meta deletion callback.',
        ],
      },
    ],
  },
  contact: {
    title: 'Contact Baunthiyal Path Lab',
    intro: 'Your Health, Our Priority',
    sections: [
      {
        title: 'Customer and booking support',
        paragraphs: [
          'Call or WhatsApp +91 63959 51791 for test and package enquiries, booking requests, existing service assistance and offer details. Staff confirm availability and collection arrangements directly.',
        ],
      },
      {
        title: 'Privacy, preferences and account requests',
        paragraphs: [
          'Use the same number for privacy questions, corrections, marketing opt-outs or data deletion requests. Clearly identify the kind of request so staff can direct it appropriately. Do not include passwords, API tokens or sensitive medical documents in an initial message.',
        ],
      },
    ],
  },
};

export function LegalPage({ slug }: { slug: string }) {
  const page = LEGAL_PAGES[slug];
  return (
    <div className="legal-page">
      <header className="legal-header">
        <Link href="/" className="public-brand">
          <img src="/logo.svg" width={44} height={44} alt="Baunthiyal Path Lab" />
          <div>
            <strong>Baunthiyal Path Lab</strong>
            <span>Your Health, Our Priority</span>
          </div>
        </Link>
        <Link href="/" className="text-button">
          Back to home
        </Link>
      </header>
      <main className="legal-content">
        <span className="eyebrow">BAUNTHIYAL PATH LAB</span>
        <h1>{page.title}</h1>
        <p className="legal-intro">{page.intro}</p>
        <p className="legal-updated">Last updated: 13 November 2026</p>
        {page.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
        <div className="legal-contact">
          <strong>Baunthiyal Path Lab</strong>
          <a href="tel:+916395951791">Call +91 63959 51791</a>
          <a href="https://wa.me/916395951791" target="_blank" rel="noopener noreferrer">
            Contact on WhatsApp
          </a>
        </div>
      </main>
      <footer className="legal-footer">
        <LegalLinks />
        <p>© {new Date().getFullYear()} Baunthiyal Path Lab</p>
      </footer>
    </div>
  );
}
