import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export type DrizzleDB = PostgresJsDatabase<typeof schema>;

@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const connectionString = configService.get<string>('DATABASE_URL')!;
        const client = postgres(connectionString);

        try {
          await client`SELECT 1`;
          Logger.log('Database connected', 'DbModule');
        } catch (error) {
          Logger.error('Database connection failed', error, 'DbModule');
          process.exit(1);
        }

        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
