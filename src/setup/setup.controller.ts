import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { SetupService, type SetupStatus } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Get('status')
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }

  @HttpCode(201)
  @Post('init')
  async init(@Body() createUser: CreateUserDto) {
    await this.setupService.initAdminRegister(createUser);
    return {
      message: `Admin ${createUser.username} created successfully`,
    };
  }
}
