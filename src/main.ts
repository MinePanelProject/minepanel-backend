import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filters';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET', 'JWT_EXPIRES_IN'];

  for (const envVar of requiredEnvVars) {
    if (!configService.get(envVar)) {
      Logger.error(`Missing required environment variable: ${envVar}`, 'Bootstrap');
      process.exit(1);
    }
  }

  app.use(cookieParser());

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.useGlobalFilters(new PrismaExceptionFilter());

  app.enableCors({
    origin: configService.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
  });

  const port = configService.get<number>('PORT', 3000);

  const config = new DocumentBuilder()
    .setTitle('MinePanel API')
    .setDescription('Minecraft server management panel API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(port);
}
void bootstrap();
