import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { CreateUserDto } from 'src/auth/dto/register.dto';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { setupState } from 'src/db/schema';
import { UsersService } from 'src/users/users.service';

export interface SetupStatus {
  initialAdminCreated: boolean;
  nextStep: 'register_admin' | 'complete';
}

@Injectable()
export class SetupService {
  constructor(
    @Inject(DRIZZLE) private db: DrizzleDB,
    private usersService: UsersService,
  ) {}

  async getSetupState(): Promise<SetupStatus> {
    // Upsert singleton row
    await this.db
      .insert(setupState)
      .values({ id: 'singleton', initialAdminCreated: false })
      .onConflictDoNothing();

    const [state] = await this.db
      .select()
      .from(setupState)
      .where(eq(setupState.id, 'singleton'))
      .limit(1);

    return {
      initialAdminCreated: state.initialAdminCreated,
      nextStep: state.initialAdminCreated ? 'complete' : 'register_admin',
    };
  }

  async markAdminCreated() {
    await this.db
      .update(setupState)
      .set({ initialAdminCreated: true })
      .where(eq(setupState.id, 'singleton'));
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
      'ADMIN',
    );

    await this.markAdminCreated();

    return true;
  }
}
