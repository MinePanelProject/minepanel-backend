import { Module } from '@nestjs/common';
import { UsersModule } from 'src/users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [PrismaModule, UsersModule],
  providers: [SetupService],
  controllers: [SetupController],
})
export class SetupModule {}
