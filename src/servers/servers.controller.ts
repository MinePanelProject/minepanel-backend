import { Controller, Post, Body } from '@nestjs/common';
// import { ServersService } from './servers.service';  // Uncomment once you have the service

@Controller('servers')
export class ServersController {
  // constructor(private readonly serversService: ServersService) {}  // Optional for now

  @Post('validate-resources')
  validateResources(@Body() body: { ram: number; cpuCores?: number, storage: number }) {
    // Simple host resource check using Node's built-in 'os' module
    const os = require('os');  // or import * as os from 'os'; at top
    const fs = require('fs');

    const stats = fs.statfsSync("/");
    const bsize = Number(stats.bsize);

    const totalBlocks = Number(stats.blocks);
    const freeBlocks = Number(stats.bfree);
    const totalStorageGB = Math.round((totalBlocks * bsize) / 1024 / 1024 / 1024);
    const freeStorageGB = Math.round((freeBlocks * bsize) / 1024 / 1024 / 1024);

    const freeRamGB = Math.round(os.freemem() / 1024 / 1024 / 1024); // in GB
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