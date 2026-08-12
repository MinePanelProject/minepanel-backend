import type { Server } from 'src/db/schema';

export type PublicServer = Omit<Server, 'rconPassword' | 'containerId' | 'worldPath'>;

export const toPublicServer = ({
  rconPassword: _rconPassword,
  containerId: _containerId,
  worldPath: _worldPath,
  ...server
}: Server): PublicServer => server;
