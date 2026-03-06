import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { DbExceptionFilter } from './common/filters/db-exception.filter';

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

  app.use(helmet());

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  app.useGlobalFilters(new DbExceptionFilter());

  app.enableCors({
    origin: configService.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
    credentials: true,
  });

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
void bootstrap();
