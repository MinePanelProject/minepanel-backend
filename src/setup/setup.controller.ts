import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator'; // We'll create this
import { SetupService, type SetupStatus } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Get('status')
  @Public() // No auth required for status check
  async getStatus(): Promise<SetupStatus> {
    return this.setupService.getSetupState();
  }
}
