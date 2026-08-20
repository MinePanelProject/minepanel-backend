import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { EditUserDto } from 'src/auth/dto/editUser.dto';
import { UpdatePasswordDTO } from 'src/auth/dto/updatePw.dto';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { type Role, refreshTokens, type User, type UserStatus, users } from 'src/db/schema';
import { type PublicUser, toPublicUser } from './public-user';

type UserInsertValues = {
  email: string;
  username: string;
  passwordHash: string;
  status: UserStatus;
  role?: Role;
};
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
    const values: UserInsertValues = { email, username, passwordHash, status };
    if (role !== undefined) {
      values.role = role;
    }
    await this.db.insert(users).values(values);
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

  async updateProfile(userId: string, dto: EditUserDto): Promise<PublicUser> {
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

      return toPublicUser(updateResult);
    }

    throw new BadRequestException('No changes');
  }

  async updatePassword(
    userId: string,
    dto: UpdatePasswordDTO,
    refreshToken: string,
    temporaryAuth = false,
  ): Promise<PublicUser> {
    const userData = await this.findById(userId);

    if (!userData) {
      throw new Error();
    }

    if (temporaryAuth) {
      // Only the forced session that consumed the temporary credential may
      // complete the change: state must still be forced, the retained hash
      // must match, and the expiry must already be consumed (null).
      const tempPasswordValid =
        userData.mustChangePassword &&
        !!userData.tempPasswordHash &&
        !userData.tempPasswordExpiresAt &&
        (await bcrypt.compare(dto.oldPassword, userData.tempPasswordHash));

      if (!tempPasswordValid) {
        throw new BadRequestException('Wrong credentials');
      }

      const newPwHash = await bcrypt.hash(dto.newPassword, 10);

      const updated = await this.db.transaction(async (tx) => {
        const [updateResult] = await tx
          .update(users)
          .set({
            passwordHash: newPwHash,
            tempPasswordHash: null,
            tempPasswordExpiresAt: null,
            mustChangePassword: false,
          })
          .where(
            and(
              eq(users.id, userId),
              eq(users.mustChangePassword, true),
              isNull(users.tempPasswordExpiresAt),
              eq(users.tempPasswordHash, userData.tempPasswordHash!),
            ),
          )
          .returning();

        if (!updateResult) {
          return null;
        }

        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
        return updateResult;
      });

      if (!updated) {
        throw new BadRequestException('Wrong credentials');
      }

      return toPublicUser(updated);
    }

    // defense in depth: an ordinary session must never complete a password
    // change while forced recovery is active
    if (userData.mustChangePassword) {
      throw new BadRequestException('Wrong credentials');
    }

    const passwordMatch = await bcrypt.compare(dto.oldPassword, userData.passwordHash);
    if (!passwordMatch) {
      throw new BadRequestException('Wrong credentials');
    }

    const newPwHash = await bcrypt.hash(dto.newPassword, 10);

    const [updateResult] = await this.db
      .update(users)
      .set({ passwordHash: newPwHash })
      .where(eq(users.id, userId))
      .returning();

    const userNoPw = toPublicUser(updateResult);
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
}
