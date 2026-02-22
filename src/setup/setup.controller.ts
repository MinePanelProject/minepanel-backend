import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { SetupService, type SetupStatus } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @ApiOperation({ summary: 'Get setup status' })
  @HttpCode(HttpStatus.OK)
  @Get('status')
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }

  @ApiOperation({ summary: 'Register first admin user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('init')
  async init(@Body() createUser: CreateUserDto) {
    await this.setupService.initAdminRegister(createUser);
    return {
      message: `Admin ${createUser.username} created successfully`,
    };
  }
}
