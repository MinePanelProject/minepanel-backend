import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client-runtime-utils';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(configService: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: configService.get<string>('DATABASE_URL'),
    });
    super({ adapter });
  }

  async onModuleInit() {
    try {
      await this.$queryRaw`SELECT 1`;
      Logger.log('Database connected', 'PrismaService');
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError) {
        Logger.error('Database connection failed', error.code, 'PrismaService');
      } else {
        Logger.error('Database connection failed', error, 'PrismaService');
      }
      process.exit(1);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
