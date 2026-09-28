// Where import options will live on an empty workspace's pages — CSV upload,
// Stripe sync — once they exist (the data model already carries `source` and
// `externalId` for them).
//
// Deliberately renders NOTHING today: a button for an import that does not work
// yet would be a dead end. Every empty state that will offer an import renders
// this in the spot it will appear, so adding one is a change to this file only.
export function ImportSlot() {
  return null;
}
