import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ServersModule } from './servers/servers.module';

@Module({
  imports: [ServersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
