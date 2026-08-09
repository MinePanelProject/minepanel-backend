import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DOCKER_REQUEST_TIMEOUT_MS } from './docker.constants';
import { DockerModule } from './docker.module';
import { DockerService } from './docker.service';

const mockPing = jest.fn();
const mockDockerodeOptions: unknown[] = [];
const mockDockerodeEnvAtConstruction: Array<{ dockerHost: string | undefined }> = [];

jest.mock('dockerode', () =>
  jest.fn().mockImplementation((opts: unknown) => {
    mockDockerodeOptions.push(opts);
    // the factory must have suppressed ambient DOCKER_HOST before construction
    mockDockerodeEnvAtConstruction.push({ dockerHost: process.env.DOCKER_HOST });
    return { ping: mockPing };
  }),
);

const originalDockerHost = process.env.DOCKER_HOST;

describe('DockerModule', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DOCKER_HOST;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    mockPing.mockReset();
    mockDockerodeOptions.length = 0;
    mockDockerodeEnvAtConstruction.length = 0;
    if (originalDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = originalDockerHost;
    }
  });

  it('compiles when the daemon is unreachable and does not call process.exit', async () => {
    mockPing.mockRejectedValue(new Error('connect ENOENT /nonexistent.sock'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    expect(module.get(DockerService)).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockDockerodeOptions[0]).toMatchObject({ timeout: DOCKER_REQUEST_TIMEOUT_MS });
  });

  it('compiles when the daemon is reachable and DockerService.ping() returns true', async () => {
    mockPing.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    const service = module.get(DockerService);

    await expect(service.ping()).resolves.toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('ignores a malformed ambient DOCKER_HOST without breaking init and restores it', async () => {
    process.env.DOCKER_HOST = '::bad::';
    mockPing.mockRejectedValue(new Error('connect ENOENT /nonexistent.sock'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    expect(module.get(DockerService)).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.env.DOCKER_HOST).toBe('::bad::');
    expect(mockDockerodeEnvAtConstruction[0].dockerHost).toBeUndefined();
    expect(mockDockerodeOptions[0]).toMatchObject({
      socketPath: expect.any(String),
      timeout: DOCKER_REQUEST_TIMEOUT_MS,
    });
  });

  it('ignores a remote TCP DOCKER_HOST and restores it', async () => {
    process.env.DOCKER_HOST = 'tcp://1.2.3.4:2375';
    mockPing.mockRejectedValue(new Error('connect ENOENT /nonexistent.sock'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    expect(module.get(DockerService)).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.env.DOCKER_HOST).toBe('tcp://1.2.3.4:2375');
    expect(mockDockerodeEnvAtConstruction[0].dockerHost).toBeUndefined();
    expect(mockDockerodeOptions[0]).toMatchObject({
      socketPath: expect.any(String),
      timeout: DOCKER_REQUEST_TIMEOUT_MS,
    });
  });

  it('does not leak the raw DOCKER_HOST into the warning', async () => {
    const warnSpy = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    process.env.DOCKER_HOST = '::bad::';
    mockPing.mockRejectedValue(new Error('connect ENOENT /nonexistent.sock'));

    await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    const dockerHostCall = warnSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('DOCKER_HOST'),
    );
    expect(dockerHostCall).toBeDefined();
    expect(dockerHostCall![0]).not.toContain('::bad::');
    warnSpy.mockRestore();
  });

  it('preserves the absence of DOCKER_HOST', async () => {
    delete process.env.DOCKER_HOST;
    mockPing.mockRejectedValue(new Error('connect ENOENT /nonexistent.sock'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [DockerModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    }).compile();

    expect(module.get(DockerService)).toBeDefined();
    expect(process.env.DOCKER_HOST).toBeUndefined();
  });
});
