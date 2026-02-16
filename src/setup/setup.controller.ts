import { Controller, Get } from '@nestjs/common';
import { SetupService, SetupStatus } from './setup.service';
import { Public } from '../common/decorators/public.decorator'; // We'll create this

@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Get('status')
  @Public() // No auth required for status check
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }
}
