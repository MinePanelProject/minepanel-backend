import { type DiskInfo, DockerService, type HostInfo } from 'src/docker/docker.service';
import { SystemMetricsService } from './system-metrics.service';

const makeService = () => {
  const docker = {
    getHostInfo: jest.fn<Promise<HostInfo>, []>(),
    getHostDiskInfo: jest.fn<Promise<DiskInfo>, []>(),
    getHostFreeMemoryMb: jest.fn<number | null, []>(),
  };
  return {
    // SAFETY: the mock methods are attached to DockerService's concrete prototype.
    service: new SystemMetricsService(
      Object.assign(Object.create(DockerService.prototype), docker),
    ),
    docker,
  };
};

describe('SystemMetricsService', () => {
  it('returns exactly the derived host snapshot', async () => {
    const { service, docker } = makeService();
    docker.getHostInfo.mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });
    docker.getHostDiskInfo.mockResolvedValue({ totalDiskMb: 10000, freeDiskMb: 7000 });
    docker.getHostFreeMemoryMb.mockReturnValue(1024);

    await expect(service.collectSnapshot()).resolves.toEqual({
      totalRamMb: 4096,
      usedRamMb: 3072,
      freeDiskMb: 7000,
      cpuCount: 8,
    });
  });

  it.each([
    ['host info null', () => ({ totalRamMb: null, cpuCount: 8 })],
    ['host info malformed', () => ({ totalRamMb: 4096.5, cpuCount: 8 })],
    ['disk info null', () => ({ totalDiskMb: 100, freeDiskMb: null })],
    ['disk info malformed', () => ({ totalDiskMb: 100, freeDiskMb: Number.NaN })],
    ['free memory null', () => null],
    ['free memory malformed', () => Number.POSITIVE_INFINITY],
    ['free exceeds total', () => 5000],
  ] as const)('returns null for %s', async (_label, mutation) => {
    const { service, docker } = makeService();
    docker.getHostInfo.mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });
    docker.getHostDiskInfo.mockResolvedValue({ totalDiskMb: 10000, freeDiskMb: 7000 });
    docker.getHostFreeMemoryMb.mockReturnValue(1024);
    if (_label.startsWith('host')) {
      // SAFETY: The table's malformed case is deliberately passed through DockerService's typed mock.
      docker.getHostInfo.mockResolvedValue(mutation() as HostInfo);
    }
    if (_label.startsWith('disk')) {
      // SAFETY: The table's malformed case is deliberately passed through DockerService's typed mock.
      docker.getHostDiskInfo.mockResolvedValue(mutation() as DiskInfo);
    }
    if (_label.startsWith('free')) {
      // SAFETY: The table's malformed case is deliberately passed through DockerService's typed mock.
      docker.getHostFreeMemoryMb.mockReturnValue(mutation() as number);
    }
    if (_label === 'free exceeds total') {
      // SAFETY: The table's malformed case is deliberately passed through DockerService's typed mock.
      docker.getHostFreeMemoryMb.mockReturnValue(mutation() as number);
    }

    await expect(service.collectSnapshot()).resolves.toBeNull();
  });

  it.each([
    ['total RAM zero', { totalRamMb: 0, cpuCount: 8 }],
    ['CPU count zero', { totalRamMb: 4096, cpuCount: 0 }],
    ['negative total RAM', { totalRamMb: -1, cpuCount: 8 }],
  ] as const)('returns null for %s', async (_label, hostInfo) => {
    const { service, docker } = makeService();
    docker.getHostInfo.mockResolvedValue(hostInfo);
    docker.getHostDiskInfo.mockResolvedValue({ totalDiskMb: 10000, freeDiskMb: 7000 });
    docker.getHostFreeMemoryMb.mockReturnValue(1024);

    await expect(service.collectSnapshot()).resolves.toBeNull();
  });

  it.each([
    'getHostInfo',
    'getHostDiskInfo',
    'getHostFreeMemoryMb',
  ] as const)('suppresses source rejection from %s', async (method) => {
    const { service, docker } = makeService();
    docker.getHostInfo.mockResolvedValue({ totalRamMb: 4096, cpuCount: 8 });
    docker.getHostDiskInfo.mockResolvedValue({ totalDiskMb: 10000, freeDiskMb: 7000 });
    docker.getHostFreeMemoryMb.mockReturnValue(1024);
    if (method === 'getHostFreeMemoryMb')
      docker[method].mockImplementation(() => {
        throw new Error('down');
      });
    else docker[method].mockRejectedValue(new Error('down'));

    await expect(service.collectSnapshot()).resolves.toBeNull();
  });
});
