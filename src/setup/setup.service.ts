import { ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { UsersService } from 'src/users/users.service';
import { PrismaService } from '../prisma/prisma.service';

export interface SetupStatus {
  initialAdminCreated: boolean;
  nextStep: 'register_admin' | 'complete';
}

@Injectable()
export class SetupService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
  ) {}

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
          initialAdminCreated: false,
        },
      });
    }

    return {
      initialAdminCreated: setupState.initialAdminCreated,
      nextStep: this.determineNextStep(setupState),
    };
  }

  async markAdminCreated() {
    await this.prisma.setupState.update({
      where: { id: 'singleton' },
      data: {
        initialAdminCreated: true,
      },
    });
  }

  async initAdminRegister(createUser: CreateUserDto): Promise<boolean> {
    const status = await this.getSetupState();

    if (status.initialAdminCreated) {
      throw new ForbiddenException('First admin already created');
    }

    const passwordHash = await bcrypt.hash(createUser.password, 10);

    await this.usersService.createUser(
      createUser.email,
      createUser.username,
      passwordHash,
      Role.ADMIN,
    );

    await this.markAdminCreated();

    return true;
  }

  private determineNextStep(state: { initialAdminCreated: boolean }): SetupStatus['nextStep'] {
    if (!state.initialAdminCreated) {
      return 'register_admin';
    }
    return 'complete';
  }
}
