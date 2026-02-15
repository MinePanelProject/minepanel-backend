import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SetupService } from './setup.service';
import { SetupController } from './setup.controller';

@Module({
  imports: [PrismaModule],
  providers: [SetupService],
  controllers: [SetupController],
})
export class SetupModule {}
