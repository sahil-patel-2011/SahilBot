// Onshape documents SahilBot created in this session. Changes inside them are routine (the agent is building
// what the user asked for, in a document that didn't exist before), so Auto runs them; changes to any other
// document are the user's existing CAD and always ask. Deleting anything asks either way.

const created = new Set<string>()

export function markCreated(did: string): void {
  if (did) created.add(did.toLowerCase())
}

export function isCreatedDoc(did: string | undefined): boolean {
  return !!did && created.has(did.toLowerCase())
}

/** Tests only. */
export function clearCreated(): void {
  created.clear()
}
