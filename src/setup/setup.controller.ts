import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { Public } from 'src/common/decorators/public.decorator';
import { SetupService, type SetupStatus } from './setup.service';

@ApiTags('setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Public()
  @ApiOperation({ summary: 'Get setup status' })
  @HttpCode(HttpStatus.OK)
  @Get('status')
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10 * 60 * 1000 } })
  @ApiOperation({ summary: 'Register first admin user' })
  @ApiHeader({
    name: 'X-Setup-Token',
    required: true,
    description:
      'One-time setup token: the configured SETUP_TOKEN value, or the bootstrap token logged once per boot while setup is incomplete. No token value is documented here on purpose.',
  })
  @ApiResponse({ status: 201, description: 'First admin created' })
  @ApiResponse({ status: 401, description: 'Missing or invalid setup token (SetupTokenInvalid)' })
  @ApiResponse({ status: 409, description: 'Setup already complete (SetupAlreadyComplete)' })
  @ApiResponse({ status: 429, description: 'Too many setup attempts from this address' })
  @HttpCode(HttpStatus.CREATED)
  @Post('init')
  async init(
    @Body() createUser: CreateUserDto,
    @Headers('x-setup-token') setupToken: string | undefined,
  ): Promise<{ message: string }> {
    await this.setupService.initAdminRegister(createUser, setupToken);
    return {
      message: `Admin ${createUser.username} created successfully`,
    };
  }
}
