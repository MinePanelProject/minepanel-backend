import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SetupStatus {
  isInitialized: boolean;
  initialAdminCreated: boolean;
  firstServerCreated: boolean;
  nextStep: 'register_admin' | 'create_server' | 'complete';
}

@Injectable()
export class SetupService {
  constructor(private prisma: PrismaService) {}

  async getSetupState(): Promise<SetupStatus> {
    // Get or create setup state (singleton)
    let setupState = await this.prisma.setupState.findUnique({
      where: { id: 'singleton' },
    });

    if (!setupState) {
      // Create initial state
      setupState = await this.prisma.setupState.create({
        data: {
          id: 'singleton',
          isInitialized: false,
          initialAdminCreated: false,
          firstServerCreated: false,
        },
      });
    }

    return {
      isInitialized: setupState.initialAdminCreated,
      initialAdminCreated: setupState.initialAdminCreated,
      firstServerCreated: setupState.firstServerCreated,
      nextStep: this.determineNextStep(setupState),
    };
  }

  async markAdminCreated() {
    await this.prisma.setupState.upsert({
      where: { id: 'singleton' },
      update: {
        initialAdminCreated: true,
        isInitialized: true,
      },
      create: {
        id: 'singleton',
        initialAdminCreated: true,
        isInitialized: true,
        firstServerCreated: false,
      },
    });
  }

  async markFirstServerCreated() {
    await this.prisma.setupState.update({
      where: { id: 'singleton' },
      data: {
        firstServerCreated: true,
      },
    });
  }

  private determineNextStep(state: {
    initialAdminCreated: boolean;
    firstServerCreated: boolean;
  }): SetupStatus['nextStep'] {
    if (!state.initialAdminCreated) {
      return 'register_admin';
    }
    if (!state.firstServerCreated) {
      return 'create_server';
    }
    return 'complete';
  }
}
