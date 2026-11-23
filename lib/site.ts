// Who runs this deployment and where to reach them — shown on the landing
// footer and the privacy and terms pages. A plain module: no secrets, safe to
// import from Server and Client Components alike.

export const SITE = {
  /** The person responsible for this instance of Meridian. */
  operator: "Parsa Motlagh",
  /** Source code; its issue tracker is the contact channel for privacy requests. */
  repository: "https://github.com/motlagh-parsa/saas-dashboard",
  /** The date the privacy policy and terms last changed (YYYY-MM-DD). */
  legalUpdated: "2026-11-23",
} as const;

export const ISSUES_URL = `${SITE.repository}/issues`;
