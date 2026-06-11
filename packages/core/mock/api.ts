// Mock async data source. Mirrors a real network API surface so the React
// Query layer can later swap to a real backend with no call-site changes.

import type { Contact, Conversation, FileDiff, Organization } from "../types";
import { CONTACTS, CONVOS, FILE_DIFFS, ORGS } from "./data";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function listOrganizations(): Promise<Organization[]> {
  await delay(0);
  return ORGS.map((o) => ({ ...o }));
}

// Assign stable per-conversation message uids ("<contactId>-<index>") so the
// stream has React keys and approve/diff lookups can target a message.
function seedConversation(contactId: string, convo: Conversation): Conversation {
  return {
    ...convo,
    messages: convo.messages.map((m, i) => ({ ...m, uid: m.uid ?? `${contactId}-${i}` })),
  };
}

export async function listContacts(): Promise<Contact[]> {
  await delay(0);
  return CONTACTS.map((c) => ({ ...c }));
}

export async function getConversation(contactId: string): Promise<Conversation | null> {
  await delay(0);
  const convo = CONVOS[contactId];
  return convo ? seedConversation(contactId, convo) : null;
}

export async function getFileDiff(path: string): Promise<FileDiff | null> {
  await delay(0);
  return FILE_DIFFS[path] ?? null;
}
