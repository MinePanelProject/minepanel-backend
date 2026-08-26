import { type ServerAccess, type ServerAccessStatus } from 'src/db/schema';

export type ServerPrincipal = {
  id: string;
  role: string;
};

export type MyAccessRequestProjection = {
  status: ServerAccessStatus;
  requestedAt: Date;
  approvedAt: Date | null;
};

export type AccessRequestProjection = {
  userId: string;
  username: string;
  email: string;
  status: ServerAccessStatus;
  requestedAt: Date;
  approvedAt: Date | null;
};

export const toMyAccessRequest = (row: ServerAccess): MyAccessRequestProjection => ({
  status: row.status,
  requestedAt: row.createdAt,
  approvedAt: row.approvedAt ?? null,
});

/** Minimal discoverable REQUEST-server projection (requestable discovery API). */
export type RequestableServerProjection = {
  id: string;
  name: string;
  accessType: 'REQUEST';
  requestStatus: 'PENDING' | null;
};
