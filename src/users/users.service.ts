import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, eq, ne, or } from 'drizzle-orm';
import { EditUserDto } from 'src/auth/dto/editUser.dto';
import { UpdatePasswordDTO } from 'src/auth/dto/updatePw.dto';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type Role, refreshTokens, type User, type UserStatus, users } from 'src/db/schema';

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private db: DrizzleDB) {}

  async createUser(
    email: string,
    username: string,
    passwordHash: string,
    status: UserStatus,
    role?: Role,
  ): Promise<boolean> {
    await this.db.insert(users).values({
      email,
      username,
      passwordHash,
      status,
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

  async updatePassword(
    userId: string,
    dto: UpdatePasswordDTO,
    refreshToken: string,
  ): Promise<Omit<User, 'passwordHash'>> {
    const userData = await this.findById(userId);

    if (!userData) {
      throw new Error();
    }

    const passwordMatch = await bcrypt.compare(dto.oldPassword, userData.passwordHash);

    if (passwordMatch) {
      const newPwHash = await bcrypt.hash(dto.newPassword, 10);

      const [updateResult] = await this.db
        .update(users)
        .set({ passwordHash: newPwHash })
        .where(eq(users.id, userId))
        .returning();

      const { passwordHash: _, ...userNoPw } = updateResult;

      const storedTokens = await this.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));

      let currentTokenId: string | null = null;
      for (const t of storedTokens) {
        if (await bcrypt.compare(refreshToken, t.token)) {
          currentTokenId = t.id;
          break;
        }
      }

      if (currentTokenId) {
        await this.db
          .delete(refreshTokens)
          .where(and(eq(refreshTokens.userId, userId), ne(refreshTokens.id, currentTokenId)));
      } else {
        await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      }

      return userNoPw;
    }

    throw new BadRequestException('Wrong credentials');
  }
}
