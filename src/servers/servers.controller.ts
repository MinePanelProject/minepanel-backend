import * as fs from 'node:fs';
import * as os from 'node:os';
import { Body, Controller, Post } from '@nestjs/common';

@Controller('servers')
export class ServersController {
  @Post('validate-resources')
  validateResources(@Body() body: { ram: number; cpuCores?: number; storage: number }) {
    const stats = fs.statfsSync('/');
    const bsize = Number(stats.bsize);

    const freeBlocks = Number(stats.bfree);
    const freeStorageGB = Math.round((freeBlocks * bsize) / 1024 / 1024 / 1024);

    const freeRamGB = Math.round(os.freemem() / 1024 / 1024 / 1024);
    const totalRamGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
    const totalCores = os.cpus().length;

    const warnings: { type: 'warning' | 'danger'; message: string }[] = [];

    if (body.ram > freeRamGB) {
      warnings.push({
        type: 'danger',
        message: `Requested RAM (${body.ram} GB) exceeds available free RAM (${freeRamGB} GB)!`,
      });
    } else if (body.ram > freeRamGB * 0.75) {
      warnings.push({
        type: 'warning',
        message: `High RAM usage warning: ${body.ram} GB is over 75% of free RAM.`,
      });
    }

    if (body.cpuCores && body.cpuCores > totalCores) {
      warnings.push({
        type: 'danger',
        message: `Requested CPU cores (${body.cpuCores}) > host cores (${totalCores}).`,
      });
    }

    if (body.storage > freeStorageGB) {
      warnings.push({
        type: 'danger',
        message: `Requested storage (${body.storage} GB) exceeds available free storage (${freeStorageGB} GB)!`,
      });
    }

    return {
      host: { totalRamGB, freeRamGB, totalCores, freeStorageGB },
      proposed: body,
      warnings,
      recommendation: warnings.length === 0 ? 'Looks good!' : 'Consider lowering resources.',
    };
  }
}
