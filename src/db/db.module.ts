import { Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export type DrizzleDB = PostgresJsDatabase<typeof schema>;

@Injectable()
class DatabaseConnection implements OnModuleDestroy {
  private readonly client: postgres.Sql;
  readonly db: DrizzleDB;

  constructor(configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL')!;
    this.client = postgres(connectionString);
    this.db = drizzle(this.client, { schema });
  }

  async connect(): Promise<void> {
    try {
      await this.client`SELECT 1`;
      Logger.log('Database connected', 'DbModule');
    } catch (error) {
      Logger.error('Database connection failed', error, 'DbModule');
      process.exit(1);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

@Module({
  providers: [
    DatabaseConnection,
    {
      provide: DRIZZLE,
      inject: [DatabaseConnection],
      useFactory: async (connection: DatabaseConnection): Promise<DrizzleDB> => {
        await connection.connect();
        return connection.db;
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DbModule {}
