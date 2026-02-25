import { Module } from '@nestjs/common';
import { DbModule } from 'src/db/db.module';
import { UsersService } from './users.service';

@Module({
  imports: [DbModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
