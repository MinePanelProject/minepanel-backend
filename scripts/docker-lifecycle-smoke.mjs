import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Dockerode from 'dockerode';

const image =
  process.env.MINECRAFT_IMAGE ??
  'itzg/minecraft-server:2026.8.2@sha256:efa878ddb49cf5251b2e5f2ad71b08fd2f7236c1f7907433f6697258b31d2ce4';
const port = Number(process.env.MINEPANEL_PORT ?? 3000);
const minecraftPort = 25575;
const networkName = `minepanel-lifecycle-${process.pid}`;
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://minepanel:minepanel@127.0.0.1:5432/minepanel';
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'minepanel-lifecycle-'));

if (!path.isAbsolute(dataRoot) || !path.basename(dataRoot).startsWith('minepanel-lifecycle-')) {
  throw new Error('Refusing to use an unsafe lifecycle data root');
}
if (image.includes(':latest') || !image.includes('@sha256:')) {
  throw new Error('Trusted lifecycle requires an immutable Minecraft image');
}

const docker = new Dockerode({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
let child;
let network;
let containerId;
let serverId;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fetchJson = async (method, route, body, cookie, setupToken) => {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (cookie !== undefined) headers.set('cookie', cookie);
  if (setupToken !== undefined) headers.set('x-setup-token', setupToken);
  const request = { method, headers };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}${route}`, request);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${text}`);
  return { body: parsed, response };
};

const waitFor = async (check, timeoutMs, description) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const cookieHeader = (response) => {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
};

const isMinecraftReady = async (container) => {
  try {
    const info = await container.inspect();
    if (info.State?.Running !== true) return false;
    const logs = await container.logs({ stderr: true, stdout: true, tail: 200 });
    return /Done \(/u.test(logs.toString());
  } catch {
    return false;
  }
};

const assertDockerConfig = async (container, expectedDataDir) => {
  const info = await container.inspect();
  if (info.Config?.Image !== image) throw new Error('Managed container image identity changed');
  if (info.Config?.Labels?.['minepanel.managed'] !== 'true') {
    throw new Error('Managed container label is missing');
  }
  if (info.Config?.Labels?.['minepanel.server-id'] !== serverId) {
    throw new Error('Managed container server label is wrong');
  }
  if (info.HostConfig?.Memory !== 512 * 1024 * 1024) throw new Error('Memory limit is wrong');
  if (info.HostConfig?.NanoCpus !== 1_000_000_000) throw new Error('CPU quota is wrong');
  if (info.HostConfig?.PidsLimit !== 512) throw new Error('PIDs limit is wrong');
  if (info.HostConfig?.Privileged !== false) throw new Error('Privileged mode is enabled');
  if ((info.HostConfig?.CapAdd ?? []).length !== 0) throw new Error('Added capabilities are enabled');
  if (info.HostConfig?.NetworkMode !== networkName) throw new Error('Managed network is wrong');
  if (info.HostConfig?.PortBindings?.['25565/tcp']?.[0]?.HostPort !== String(minecraftPort)) {
    throw new Error('Minecraft port binding is wrong');
  }

  const mount = info.Mounts?.find((candidate) => candidate.Destination === '/data');
  if (!mount || mount.Source !== expectedDataDir || mount.RW !== true) {
    throw new Error('Minecraft data bind mount is wrong');
  }
  if (!info.NetworkSettings?.Networks?.[networkName]) throw new Error('Network attachment is missing');
  return info;
};

const pullImage = async () => {
  const stream = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
};

try {
  await pullImage();

  network = await docker.createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Labels: { 'minepanel.test': 'trusted-lifecycle' },
  });

  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'trusted-lifecycle-jwt-secret-long-enough',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
    SETUP_TOKEN: 'trusted-lifecycle-setup-token',
    DOCKER_SOCKET: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    DOCKER_NETWORK: networkName,
    MC_DATA_PATH: dataRoot,
    MC_DATA_BIND_SOURCE: dataRoot,
    MINECRAFT_IMAGE: image,
    MIN_FREE_DISK_MB: '1',
    MC_CPU_NANO_CPUS: '1000000000',
    MC_PIDS_LIMIT: '512',
    MC_PORT_MIN: String(minecraftPort),
    MC_PORT_MAX: String(minecraftPort),
    MAX_MEMORY_RATIO: '0.9',
    STOP_WARN_SECONDS: '0',
    REQUIRE_ADMIN_APPROVAL: 'false',
    PORT: String(port),
  };

  child = spawn('bun', ['dist/src/main.js'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        return response.status === 200 || response.status === 503;
      } catch {
        return false;
      }
    },
    120_000,
    'MinePanel HTTP readiness',
  );

  await fetchJson('POST', '/api/setup/init', {
    email: 'trusted-lifecycle@example.com',
    username: 'trustedlifecycle',
    password: 'TrustedPass123!',
  }, undefined, 'trusted-lifecycle-setup-token').then(({ response }) => {
    if (response.status !== 201) throw new Error('Bootstrap did not create the admin');
  });

  const login = await fetchJson('POST', '/api/auth/login', {
    identifier: 'trustedlifecycle',
    password: 'TrustedPass123!',
  });
  const cookie = cookieHeader(login.response);
  if (!cookie) throw new Error('Login did not issue session cookies');

  const created = await fetchJson('POST', '/api/servers', {
    name: 'Trusted Lifecycle',
    provider: 'PAPER',
    version: '1.21.1',
    memoryLimitMb: 512,
    port: minecraftPort,
  }, cookie);
  serverId = created.body.id;
  const managed = await docker.listContainers({
    all: true,
    filters: { label: [`minepanel.server-id=${serverId}`] },
  });
  containerId = managed[0]?.Id;
  if (!serverId || !containerId || created.body.status !== 'RUNNING') {
    throw new Error('Server creation did not produce a running managed container');
  }

  const container = docker.getContainer(containerId);
  const expectedDataDir = path.join(dataRoot, serverId);
  await assertDockerConfig(container, expectedDataDir);
  await waitFor(
    () => isMinecraftReady(container),
    180_000,
    'Minecraft container readiness log',
  );

  await fetchJson('POST', `/api/servers/${serverId}/stop`, undefined, cookie);
  await waitFor(
    async () => (await container.inspect()).State?.Running === false,
    60_000,
    'graceful Minecraft stop',
  );

  await fetchJson('DELETE', `/api/servers/${serverId}`, undefined, cookie);
  await waitFor(
    async () => {
      try {
        await container.inspect();
        return false;
      } catch (error) {
        return error?.statusCode === 404 || error?.status === 404;
      }
    },
    30_000,
    'container removal',
  );
  await access(expectedDataDir);
  console.log(`trusted Docker lifecycle passed for ${serverId}`);
} finally {
  if (child && !child.killed) child.kill('SIGTERM');
  if (containerId) {
    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      if (
        info.Config?.Labels?.['minepanel.managed'] === 'true' &&
        info.Config?.Labels?.['minepanel.server-id'] === serverId
      ) {
        await container.remove({ force: true });
      }
    } catch {}
  }
  if (network) {
    try {
      await network.remove();
    } catch {}
  }
  await rm(dataRoot, { recursive: true, force: true });
}
