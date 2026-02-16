import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ServersModule } from './servers/servers.module';
import { SetupModule } from './setup/setup.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServersModule,
    PrismaModule,
    SetupModule,
    PrismaModule,
    SetupModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
