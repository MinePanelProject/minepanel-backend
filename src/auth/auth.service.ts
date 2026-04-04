import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { decrypt, encrypt } from 'src/common/crypto.util';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { RefreshToken, refreshTokens, type User, users } from 'src/db/schema';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';

export interface AuthTokens {
  user: Omit<User, 'passwordHash'>;
  accessToken: string;
  refreshToken: string;
}

export type LoginResponse =
  | { requiresTwoFactor: true; preAuthToken: string }
  | { user: Omit<User, 'passwordHash'>; accessToken: string; refreshToken: string };

@Injectable()
export class AuthService {
  private readonly encryptionKey: string;

  constructor(
    private readonly usersService: UsersService,
    private jwtService: JwtService,
    @Inject(DRIZZLE) private db: DrizzleDB,
    private configService: ConfigService,
  ) {
    this.encryptionKey = this.configService.get<string>('ENCRYPTION_KEY')!;
  }

  async registerUser(createUser: CreateUserDto): Promise<boolean> {
    const userExists = await this.usersService.findByIdentifier(
      createUser.username || createUser.email,
    );

    if (userExists) {
      throw new ConflictException('User already exists');
    }

    const passwordHash = await bcrypt.hash(createUser.password, 10);

    const requireApproval = this.configService.get<string>('REQUIRE_ADMIN_APPROVAL') === 'true';

    await this.usersService.createUser(
      createUser.email,
      createUser.username,
      passwordHash,
      requireApproval ? 'PENDING' : 'ACTIVE',
    );

    return true;
  }

  async loginUser(loginUser: LoginUserDto): Promise<LoginResponse> {
    const user = await this.usersService.findByIdentifier(loginUser.identifier);

    const passwordMatches = await bcrypt.compare(
      loginUser.password,
      user?.passwordHash ?? '$2b$10$dummyhashtopreventtimingattack000000000000000',
    );

    if (!user || !passwordMatches) throw new UnauthorizedException('Wrong credentials');

    if (user.totpEnabled) {
      const preAuthToken = await this.jwtService.signAsync(
        {
          sub: user.id,
          type: 'pre-auth',
        },
        { expiresIn: '5m' },
      );

      return { requiresTwoFactor: true, preAuthToken };
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    const refreshToken = await this.jwtService.signAsync({ sub: user.id }, { expiresIn: '7d' });

    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    await this.storeRefreshToken(user.id, hashedRefreshToken);

    const { passwordHash, ...userWithoutPassword } = user;

    return { user: userWithoutPassword, accessToken, refreshToken };
  }

  async logoutUser(userId: string, refreshToken: AuthTokens['refreshToken']) {
    const storedTokens = await this.db
      .select({ id: refreshTokens.id, token: refreshTokens.token })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    for (const tokenEntry of storedTokens) {
      const matches = await bcrypt.compare(refreshToken, tokenEntry.token);
      if (matches) {
        await this.db.delete(refreshTokens).where(eq(refreshTokens.id, tokenEntry.id));
        break;
      }
    }
  }

  async logoutAll(userId: string) {
    await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }

  async storeRefreshToken(userId: string, hashedRefreshToken: string) {
    await this.db.insert(refreshTokens).values({
      token: hashedRefreshToken,
      userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  }

  async refreshTokens(refreshToken: AuthTokens['refreshToken']) {
    const decoded = await this.jwtService.verifyAsync<{ sub: string }>(refreshToken);
    const userId = decoded.sub;

    const storedTokens = await this.db
      .select({
        id: refreshTokens.id,
        token: refreshTokens.token,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    for (const tokenEntry of storedTokens) {
      const matches = await bcrypt.compare(refreshToken, tokenEntry.token);
      if (!matches) continue;

      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) throw new UnauthorizedException();

      const newAccessToken = await this.jwtService.signAsync({
        sub: user.id,
        username: user.username,
        role: user.role,
      });

      await this.db.delete(refreshTokens).where(eq(refreshTokens.id, tokenEntry.id));

      const newRefreshToken = await this.jwtService.signAsync(
        { sub: user.id },
        { expiresIn: '7d' },
      );

      const hashedNew = await bcrypt.hash(newRefreshToken, 10);
      await this.storeRefreshToken(user.id, hashedNew);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    }

    throw new UnauthorizedException();
  }

  async getSessions(userId: string): Promise<Omit<RefreshToken, 'token'>[]> {
    const { token: _token, ...tableWithoutToken } = getTableColumns(refreshTokens);

    const tokens = await this.db
      .select(tableWithoutToken)
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));

    return tokens;
  }

  async deleteSingleSession(userId: string, tokenId: string) {
    await this.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.id, tokenId)));
  }

  async editUserProfile(userId: string, dto: EditUserDto): Promise<Omit<User, 'passwordHash'>> {
    return await this.usersService.updateProfile(userId, dto);
  }

  async updateUserPassword(
    userId: string,
    dto: UpdatePasswordDTO,
    refreshToken: AuthTokens['refreshToken'],
  ): Promise<Omit<User, 'passwordHash'>> {
    return await this.usersService.updatePassword(userId, dto, refreshToken);
  }

  async setup2FA(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (user.totpEnabled) {
      throw new BadRequestException();
    }

    const secret = generateSecret();

    const qrUri = generateURI({ issuer: 'MinePanel', label: user.email, secret });

    const encryptedSecret = encrypt(secret, this.encryptionKey);

    await this.db.update(users).set({ totpSecret: encryptedSecret }).where(eq(users.id, userId));

    return { secret, uri: qrUri };
  }

  async confirm2FA(userId: string, token: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (!user.totpSecret) {
      throw new BadRequestException();
    }

    const secret = decrypt(user.totpSecret, this.encryptionKey);

    const isValid = verifySync({ secret, token, epochTolerance: 1 });

    if (!isValid) {
      throw new BadRequestException();
    }

    const backupCodes: string[] = [];

    for (let i = 0; i < 8; i++) {
      const pt1 = crypto.randomBytes(4).toString('hex');
      const pt2 = crypto.randomBytes(4).toString('hex');

      const code = `${pt1}-${pt2}`;

      backupCodes.push(code);
    }

    const hashedCodes = await Promise.all(backupCodes.map((code) => bcrypt.hash(code, 10)));

    const JsonBackupCodes = JSON.stringify(hashedCodes);

    await this.db
      .update(users)
      .set({ totpBackupCodes: JsonBackupCodes, totpEnabled: true })
      .where(eq(users.id, userId));

    return { backupCodes };
  }

  async verify2FA(userId: string, token: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (!user.totpSecret) {
      throw new BadRequestException();
    }

    const secret = decrypt(user.totpSecret, this.encryptionKey);

    const isValid = verifySync({ secret, token, epochTolerance: 1 });

    if (!isValid) {
      const usedBackup = await this.verifyAndConsumeBackupCode(user, token);
      if (!usedBackup) throw new BadRequestException();
    }

    return true;
  }

  async disable2FA(userId: string, token: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (!user.totpSecret) {
      throw new BadRequestException();
    }

    const secret = decrypt(user.totpSecret, this.encryptionKey);

    const isValid = verifySync({ secret, token, epochTolerance: 1 });

    if (!isValid) {
      const usedBackup = await this.verifyAndConsumeBackupCode(user, token);
      if (!usedBackup) throw new BadRequestException();
    }

    await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null })
      .where(eq(users.id, userId));

    return true;
  }

  async verifyAndConsumeBackupCode(user: User, token: string) {
    if (!user.totpBackupCodes) return false;

    const codes = JSON.parse(user.totpBackupCodes);

    for (const hashedCode of codes) {
      const matches = await bcrypt.compare(token, hashedCode);
      if (matches) {
        const filteredCodes = codes.filter((matchedCode) => matchedCode !== hashedCode);
        const clearedCodes = JSON.stringify(filteredCodes);

        await this.db
          .update(users)
          .set({ totpBackupCodes: clearedCodes })
          .where(eq(users.id, user.id));

        return true;
      }
    }

    return false;
  }
}
