import path from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getCanonicalCorsOrigin } from './common/cors-origin';
import { CustomLogger } from './common/custom-logger';
import { DbExceptionFilter } from './common/filters/db-exception.filter';
import { runProductionMigrations } from './db/migrate';
import { SocketIoAdapter } from './gateway/socket-io.adapter';
import { SocketReservationService } from './gateway/socket-reservation.service';

function runProductionPreflight(configService: ConfigService): void {
  const databaseUrl = configService.get<string>('DATABASE_URL');

  if (
    typeof databaseUrl !== 'string' ||
    databaseUrl.length === 0 ||
    databaseUrl !== databaseUrl.trim()
  ) {
    throw new Error('Missing required environment configuration');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Missing required environment configuration');
  }

  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('Missing required environment configuration');
  }

  const jwtSecret = configService.get<string>('JWT_SECRET');
  const jwtExpiresIn = configService.get<string>('JWT_EXPIRES_IN');
  const PLACEHOLDER_JWT_SECRET = 'your-jwt-secret-here-make-it-long-and-random';

  if (
    typeof jwtSecret !== 'string' ||
    jwtSecret.length < 32 ||
    jwtSecret === PLACEHOLDER_JWT_SECRET ||
    typeof jwtExpiresIn !== 'string' ||
    jwtExpiresIn.length === 0
  ) {
    throw new Error('Missing required environment configuration');
  }

  const encryptionKey = configService.get<string>('ENCRYPTION_KEY');

  if (typeof encryptionKey !== 'string' || !/^[0-9a-f]{64}$/iu.test(encryptionKey)) {
    throw new Error('Missing required environment configuration');
  }

  const dockerSocket = configService.get<string>('DOCKER_SOCKET', '/var/run/docker.sock');

  if (
    typeof dockerSocket !== 'string' ||
    dockerSocket.length === 0 ||
    !dockerSocket.startsWith('/') ||
    dockerSocket.startsWith('tcp://')
  ) {
    throw new Error('Missing required environment configuration');
  }

  const rawCorsOrigin = configService.get<string>('CORS_ORIGIN');
  if (typeof rawCorsOrigin !== 'string' || rawCorsOrigin.length === 0) {
    // no implicit localhost fallback in production (Compose requires the var)
    throw new Error('Missing required environment configuration');
  }
  const corsOrigin = getCanonicalCorsOrigin(configService);
  const parsedCorsOrigin = new URL(corsOrigin);
  const isLoopbackOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    parsedCorsOrigin.hostname,
  );

  // production cookies are Secure: only https origins (or loopback test
  // origins, which browsers treat as secure contexts) can receive them
  if (parsedCorsOrigin.protocol !== 'https:' && !isLoopbackOrigin) {
    throw new Error('Missing required environment configuration');
  }
}

async function bootstrap() {
  const logger = new CustomLogger();
  const configService = new ConfigService();

  if (process.env.NODE_ENV === 'production') {
    runProductionPreflight(configService);
    await runProductionMigrations(
      configService.get<string>('DATABASE_URL')!,
      path.resolve(process.cwd(), 'drizzle'),
    );
  }

  const app = await NestFactory.create(AppModule, { logger });

  // the only inbound path is the Caddy reverse proxy on the app network:
  // honor X-Forwarded-* from it so protocol/host detection (CSRF same-origin
  // check) and per-client throttling see the real client
  const httpAdapter = app.getHttpAdapter().getInstance() as {
    set: (setting: string, value: unknown) => void;
  };
  httpAdapter.set('trust proxy', 1);

  app.use(helmet());

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  app.useGlobalFilters(new DbExceptionFilter());

  app.enableShutdownHooks();

  const canonicalOrigin = getCanonicalCorsOrigin(configService);

  app.enableCors({
    origin: canonicalOrigin,
    credentials: true,
  });

  app.useWebSocketAdapter(
    new SocketIoAdapter(app.get(SocketReservationService), configService, app.getHttpServer()),
  );

  app.setGlobalPrefix('api', { exclude: ['/health'] });

  const port = configService.get<number>('PORT', 3000);

  const config = new DocumentBuilder()
    .setTitle(`${configService.get<string>('PANEL_NAME', 'MinePanel')} API`)
    .setDescription(
      configService.get<string>('PANEL_DESCRIPTION', 'Minecraft server management panel API'),
    )
    .setVersion(configService.get<string>('PANEL_VERSION', 'N/A'))
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
}

async function main(): Promise<void> {
  try {
    await bootstrap();
  } catch {
    Logger.error('Bootstrap failed', 'Bootstrap');
    process.exit(1);
  }
}

void main();
