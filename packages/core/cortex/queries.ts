// React Query options + query keys for Cortex Desktop server-state.
// Keys are namespaced by workspace id (wsId) so switching workspace never
// leaks another workspace's cached data.

import { queryOptions } from "@tanstack/react-query";
import { getConversation, getFileDiff, listContacts, listOrganizations } from "../mock/api";

// Organizations are global (not workspace-scoped), so their key carries no wsId.
export const organizationKeys = {
  all: () => ["organizations"] as const,
  list: () => [...organizationKeys.all(), "list"] as const,
};

export const organizationListOptions = () =>
  queryOptions({
    queryKey: organizationKeys.list(),
    queryFn: () => listOrganizations(),
  });

export const contactKeys = {
  all: (wsId: string) => ["contacts", wsId] as const,
  list: (wsId: string) => [...contactKeys.all(wsId), "list"] as const,
};

export const conversationKeys = {
  all: (wsId: string) => ["conversation", wsId] as const,
  detail: (wsId: string, contactId: string) => [...conversationKeys.all(wsId), contactId] as const,
};

export const fileDiffKeys = {
  all: (wsId: string) => ["fileDiff", wsId] as const,
  detail: (wsId: string, path: string) => [...fileDiffKeys.all(wsId), path] as const,
};

export const contactListOptions = (wsId: string) =>
  queryOptions({
    queryKey: contactKeys.list(wsId),
    queryFn: () => listContacts(),
  });

export const conversationOptions = (wsId: string, contactId: string) =>
  queryOptions({
    queryKey: conversationKeys.detail(wsId, contactId),
    queryFn: () => getConversation(contactId),
  });

export const fileDiffOptions = (wsId: string, path: string) =>
  queryOptions({
    queryKey: fileDiffKeys.detail(wsId, path),
    queryFn: () => getFileDiff(path),
  });
