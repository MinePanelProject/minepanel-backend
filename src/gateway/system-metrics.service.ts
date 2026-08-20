import { Injectable } from '@nestjs/common';
import { DockerService } from 'src/docker/docker.service';

export type SystemStats = {
  totalRamMb: number;
  usedRamMb: number;
  freeDiskMb: number;
  cpuCount: number;
};

const isSafeNonNegativeInteger = (value: number | null | undefined): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

@Injectable()
export class SystemMetricsService {
  constructor(private readonly dockerService: DockerService) {}

  async collectSnapshot(): Promise<SystemStats | null> {
    let hostInfo: { totalRamMb: number | null; cpuCount: number | null };
    let diskInfo: { totalDiskMb: number | null; freeDiskMb: number | null };
    let freeRamMb: number | null;

    try {
      hostInfo = await this.dockerService.getHostInfo();
      diskInfo = await this.dockerService.getHostDiskInfo();
      freeRamMb = this.dockerService.getHostFreeMemoryMb();
    } catch {
      return null;
    }

    const totalRamMb = hostInfo.totalRamMb;
    const cpuCount = hostInfo.cpuCount;
    const freeDiskMb = diskInfo.freeDiskMb;

    if (
      !isSafeNonNegativeInteger(totalRamMb) ||
      !isSafeNonNegativeInteger(cpuCount) ||
      !isSafeNonNegativeInteger(freeRamMb) ||
      !isSafeNonNegativeInteger(freeDiskMb) ||
      totalRamMb <= 0 ||
      cpuCount <= 0 ||
      freeRamMb > totalRamMb
    ) {
      return null;
    }

    return {
      totalRamMb,
      usedRamMb: totalRamMb - freeRamMb,
      freeDiskMb,
      cpuCount,
    };
  }
}
