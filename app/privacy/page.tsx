// /privacy — what this deployment of Meridian stores, why, who else sees it,
// and how to get it deleted. Written against what the code actually does:
// keep it in step when a feature starts storing something new.
import type { Metadata } from "next";

import { LegalList, LegalPage, LegalSection, TextLink } from "@/components/marketing/legal-page";
import { ISSUES_URL, SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Meridian stores, why, who else sees it, and how to have it deleted.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      summary="Meridian stores what it needs to compute your metrics and run your account — nothing for advertising, and nothing sold."
    >
      <LegalSection id="who" title="Who runs this service">
        <p>
          Meridian is an open-source project run by {SITE.operator} as an individual, not a company. The code is public
          at <TextLink href={SITE.repository}>{SITE.repository.replace("https://", "")}</TextLink>, so you can check
          what is described here against what the software does.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What is stored">
        <LegalList
          items={[
            <>
              <strong className="font-medium text-foreground">Your account:</strong> your name and email address, and
              your password as a one-way scrypt hash — never the password itself. If you sign in with GitHub, the name,
              email and avatar GitHub shares instead.
            </>,
            <>
              <strong className="font-medium text-foreground">The billing data you bring:</strong> customers, plans,
              subscriptions and invoices, whether entered by hand, imported from a CSV, sent over the API or synced from
              Stripe. This can include your customers&apos; names and email addresses.
            </>,
            <>
              <strong className="font-medium text-foreground">Connection secrets:</strong> a Stripe restricted key, if
              you connect Stripe, encrypted with AES-256-GCM. API keys and every email link (confirmation, password
              reset, invite) are stored only as SHA-256 hashes.
            </>,
            <>
              <strong className="font-medium text-foreground">Workspace activity:</strong> an audit log of who changed
              what in a workspace, in-app notifications, import history, and your notification and report settings.
            </>,
            <>
              <strong className="font-medium text-foreground">Page performance:</strong> loading-speed measurements
              (Core Web Vitals) with the page path only — no user, no IP address.
            </>,
          ]}
        />
        <p>
          The hosting provider keeps standard request logs, which include IP addresses, under its own policy. Meridian
          itself does not store IP addresses.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>Three cookies, all first-party and all needed for the app to work:</p>
        <LegalList
          items={[
            "the sign-in session;",
            <>
              <code className="font-mono text-sm">meridian_org</code> — which workspace you last opened;
            </>,
            <>
              <code className="font-mono text-sm">meridian_theme</code> — light, dark or system.
            </>,
          ]}
        />
        <p>There are no analytics, advertising or third-party scripts on any page.</p>
      </LegalSection>

      <LegalSection id="use" title="How it is used">
        <p>
          Only to run the service for you: to compute and show your metrics, to sync the sources you connect, and to
          send the emails the product sends — address confirmation, password reset, invitations, alerts, the weekly
          summary and the reports you schedule. Alert and summary emails can be turned off in your profile settings, and
          a scheduled report can be removed at any time.
        </p>
        <p>
          Your data is not sold, rented or used to train anything, and it is not looked at except to fix a problem you
          report.
        </p>
      </LegalSection>

      <LegalSection id="processors" title="Who else handles it">
        <p>Only the services this deployment runs on, each acting on the service&apos;s behalf:</p>
        <LegalList
          items={[
            "the hosting provider, which serves the app;",
            "the database provider, which stores the data;",
            "the email provider, which delivers the emails listed above.",
          ]}
        />
        <p>
          If you connect Stripe, Meridian reads from Stripe with the key you gave it; it never writes to your Stripe
          account.
        </p>
      </LegalSection>

      <LegalSection id="your-customers" title="Your customers' data">
        <p>
          When you bring in billing data about your own customers, you decide what goes in and you are responsible for
          having the right to process it. Meridian processes it only to give you your metrics, and only people you
          invite to the workspace can see it.
        </p>
      </LegalSection>

      <LegalSection id="delete" title="Keeping and deleting data">
        <LegalList
          items={[
            "Data stays until it is deleted. Records you delete in the app are gone, not hidden.",
            "A workspace owner can delete the whole workspace from Settings; that removes all of its data at once.",
            <>
              To delete your account, or to get a copy of what is stored about you, open an issue at{" "}
              <TextLink href={ISSUES_URL}>the project&apos;s issue tracker</TextLink> asking to be contacted — don&apos;t
              put personal details in the issue itself.
            </>,
            "The public demo is rebuilt every night, so anything entered there is erased within a day.",
          ]}
        />
      </LegalSection>

      <LegalSection id="security" title="Security">
        <p>
          Every request checks that you belong to the workspace whose data it touches. Connections are encrypted in
          transit, and the secrets above are hashed or encrypted at rest. No system is perfectly secure; if you find a
          weakness, please report it privately rather than in a public issue.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes">
        <p>
          If this policy changes, the date at the top changes with it, and the history of every change is visible in
          the source repository.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
