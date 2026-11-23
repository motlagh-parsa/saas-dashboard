// /terms — the plain-language terms of use for this deployment.
import type { Metadata } from "next";

import { LegalList, LegalPage, LegalSection, TextLink } from "@/components/marketing/legal-page";
import { ISSUES_URL, SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms for using this deployment of Meridian.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      summary="Meridian is free to use and provided as it is. These terms say what you can expect from it, and what it expects from you."
    >
      <LegalSection id="service" title="The service">
        <p>
          Meridian is an open-source project run by {SITE.operator} as an individual. Using this deployment is free.
          It may change, be unavailable at times, or be shut down.
        </p>
      </LegalSection>

      <LegalSection id="account" title="Your account">
        <LegalList
          items={[
            "Give a real email address you control, and keep your password to yourself.",
            "You are responsible for what happens in workspaces you own, including the people you invite and the API keys you create.",
          ]}
        />
      </LegalSection>

      <LegalSection id="data" title="Your data">
        <p>
          What you bring into Meridian stays yours. You give the service permission to store and process it only to
          run Meridian for you, as the <TextLink href="/privacy">privacy policy</TextLink> describes. You must have the
          right to use any data about your customers that you bring in.
        </p>
      </LegalSection>

      <LegalSection id="acceptable-use" title="Acceptable use">
        <p>Don&apos;t:</p>
        <LegalList
          items={[
            "upload data you have no right to, or anything unlawful;",
            "try to reach other people's workspaces, or test the service's security without permission;",
            "overload the service, or get around the API's rate limits;",
            "use the public demo to store anything real — it is erased every night.",
          ]}
        />
        <p>Accounts that do these things may be suspended.</p>
      </LegalSection>

      <LegalSection id="numbers" title="About the numbers">
        <p>
          Meridian&apos;s figures are computed from the data you provide, and are only as accurate as that data. They
          are for information — not accounting, tax or investment advice.
        </p>
      </LegalSection>

      <LegalSection id="warranty" title="No warranty">
        <p>
          The service is provided &quot;as is&quot;, without any warranty. To the extent the law allows, the operator is
          not liable for any loss arising from its use, including lost data or decisions made on its figures. Keep your
          own copy of anything important — every view can be exported as CSV.
        </p>
      </LegalSection>

      <LegalSection id="code" title="The code">
        <p>
          The source code is available under the MIT License at{" "}
          <TextLink href={SITE.repository}>{SITE.repository.replace("https://", "")}</TextLink>. These terms cover using
          this deployment; the license covers the code.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact and changes">
        <p>
          Questions go to <TextLink href={ISSUES_URL}>the project&apos;s issue tracker</TextLink>. If these terms change,
          the date at the top changes with them.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
