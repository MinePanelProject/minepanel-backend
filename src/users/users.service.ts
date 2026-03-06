import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { EditUserDto } from 'src/auth/dto/editUser.dto';
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

  async updateProfile(userId: string, dto: EditUserDto): Promise<Omit<User, 'passwordHash'>> {
    const userData = await this.findById(userId);

    const updateData = Object.fromEntries(Object.entries(dto).filter(([_, v]) => v !== undefined));

    if (!userData) {
      throw new Error();
    }

    const noChangedData = Object.entries(updateData).every(([k, v]) => v === userData[k]);

    if (!noChangedData) {
      const [updateResult] = await this.db
        .update(users)
        .set(updateData)
        .where(eq(users.id, userId))
        .returning();

      const { passwordHash: _, ...userNoPw } = updateResult;

      return userNoPw;
    }

    throw new BadRequestException('No changes');
  }
}
