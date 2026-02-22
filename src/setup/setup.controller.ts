import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { SetupService, type SetupStatus } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @ApiOperation({ summary: 'Get setup status' })
  @Get('status')
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }

  @ApiOperation({ summary: 'Register first admin user' })
  @HttpCode(201)
  @Post('init')
  async init(@Body() createUser: CreateUserDto) {
    await this.setupService.initAdminRegister(createUser);
    return {
      message: `Admin ${createUser.username} created successfully`,
    };
  }
}
