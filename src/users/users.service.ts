import { Inject, Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type Role, type User, users } from 'src/db/schema';

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private db: DrizzleDB) {}

  async createUser(
    email: string,
    username: string,
    passwordHash: string,
    role?: Role,
  ): Promise<boolean> {
    await this.db.insert(users).values({
      email,
      username,
      passwordHash,
      ...(role ? { role } : {}),
    });
    return true;
  }

  async findById(id: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(or(eq(users.email, identifier), eq(users.username, identifier)))
      .limit(1);
    return user ?? null;
  }
}
