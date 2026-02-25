import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { UsersModule } from 'src/users/users.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [DbModule, UsersModule],
  providers: [SetupService],
  controllers: [SetupController],
})
export class SetupModule {}
