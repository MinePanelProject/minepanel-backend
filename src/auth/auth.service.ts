import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';

const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_FACTOR_FAILURE_LIMIT = 5;
const TWO_FACTOR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const TWO_FACTOR_LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = '$2b$10$ImDussfxY6I73mT10z0lU.DyrhBuXdRh7CBiLNf0nJM3yNj1asche';
const TOTP_WINDOW_SECONDS = 30;

export interface AuthTokens {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export type TwoFactorChallenge = { requiresTwoFactor: true; preAuthToken: string };
export type LoginResponse = AuthTokens | TwoFactorChallenge;

type TwoFactorFailure = { failures: number; firstFailureAt: number; lockedUntil?: number };

@Injectable()
export class AuthService {
  private readonly encryptionKey: string;
  private readonly twoFactorFailures = new Map<string, TwoFactorFailure>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly configService: ConfigService,
  ) {
    const encryptionKey = this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey || !/^[\da-f]{64}$/i.test(encryptionKey)) {
      throw new Error('Invalid ENCRYPTION_KEY: expected 64 hexadecimal characters (32 bytes).');
    }

    this.encryptionKey = encryptionKey;
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
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Wrong credentials');
    }

    this.assertLoginAllowed(user);

    if (user.totpEnabled) {
      const preAuthToken = await this.jwtService.signAsync(
        { sub: user.id, type: 'pre-auth' },
        { expiresIn: '5m' },
      );

      return { requiresTwoFactor: true, preAuthToken };
    }

    return this.issueSession(user);
  }

  async completeTwoFactorLogin(userId: string, token: string): Promise<AuthTokens> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException();
    }

    this.assertLoginAllowed(user);
    this.assertTwoFactorNotLocked(user.id);

    const isValidTotp = this.isValidTotp(user, token);
    const usedBackupCode = isValidTotp ? false : await this.verifyAndConsumeBackupCode(user, token);

    if (!isValidTotp && !usedBackupCode) {
      this.recordTwoFactorFailure(user.id);
      throw new UnauthorizedException('Invalid two-factor code');
    }

    this.twoFactorFailures.delete(user.id);
    return this.issueSession(user);
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
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
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
      if (!matches) {
        continue;
      }

      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        throw new UnauthorizedException();
      }

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

    return this.db
      .select(tableWithoutToken)
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
  }

  async deleteSingleSession(userId: string, tokenId: string) {
    await this.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.id, tokenId)));
  }

  async editUserProfile(userId: string, dto: EditUserDto): Promise<PublicUser> {
    return this.usersService.updateProfile(userId, dto);
  }

  async updateUserPassword(
    userId: string,
    dto: UpdatePasswordDTO,
    refreshToken: AuthTokens['refreshToken'],
  ): Promise<PublicUser> {
    return this.usersService.updatePassword(userId, dto, refreshToken);
  }

  async setup2FA(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (user.totpEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled');
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

    if (user.totpEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled');
    }

    if (!user.totpSecret) {
      throw new BadRequestException();
    }

    if (!this.isValidTotp(user, token)) {
      throw new BadRequestException();
    }

    const backupCodes = Array.from({ length: 8 }, () => {
      const first = crypto.randomBytes(4).toString('hex');
      const second = crypto.randomBytes(4).toString('hex');
      return `${first}-${second}`;
    });
    const hashedCodes = await Promise.all(backupCodes.map((code) => bcrypt.hash(code, 10)));

    await this.db
      .update(users)
      .set({ totpBackupCodes: JSON.stringify(hashedCodes), totpEnabled: true })
      .where(eq(users.id, userId));

    return { backupCodes };
  }

  async disable2FA(userId: string, token: string) {
    const user = await this.usersService.findById(userId);

    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException();
    }

    const isValidTotp = this.isValidTotp(user, token);
    const usedBackupCode = isValidTotp ? false : await this.verifyAndConsumeBackupCode(user, token);

    if (!isValidTotp && !usedBackupCode) {
      throw new BadRequestException();
    }

    await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecret: null, totpBackupCodes: null })
      .where(eq(users.id, userId));

    return true;
  }

  private async issueSession(user: User): Promise<AuthTokens> {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      username: user.username,
      role: user.role,
    });
    const refreshToken = await this.jwtService.signAsync({ sub: user.id }, { expiresIn: '7d' });

    await this.storeRefreshToken(user.id, await bcrypt.hash(refreshToken, 10));

    return { user: toPublicUser(user), accessToken, refreshToken };
  }

  private assertLoginAllowed(user: User): void {
    if (user.status === 'PENDING') {
      throw new ForbiddenException({ error: 'AccountPending' });
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException({ error: 'AccountBanned' });
    }
  }

  private isValidTotp(user: User, token: string): boolean {
    return verifySync({
      secret: decrypt(user.totpSecret!, this.encryptionKey),
      token,
      epochTolerance: TOTP_WINDOW_SECONDS,
    }).valid;
  }

  private assertTwoFactorNotLocked(userId: string): void {
    const failure = this.twoFactorFailures.get(userId);
    if (!failure?.lockedUntil) {
      return;
    }

    if (failure.lockedUntil > Date.now()) {
      throw new HttpException(
        'Two-factor authentication is temporarily locked',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.twoFactorFailures.delete(userId);
  }

  private recordTwoFactorFailure(userId: string): void {
    const now = Date.now();
    const previous = this.twoFactorFailures.get(userId);
    const activeFailure =
      previous && now - previous.firstFailureAt < TWO_FACTOR_ATTEMPT_WINDOW_MS
        ? previous
        : undefined;
    const failures = (activeFailure?.failures ?? 0) + 1;

    this.twoFactorFailures.set(
      userId,
      failures >= TWO_FACTOR_FAILURE_LIMIT
        ? {
            failures,
            firstFailureAt: activeFailure?.firstFailureAt ?? now,
            lockedUntil: now + TWO_FACTOR_LOCKOUT_MS,
          }
        : { failures, firstFailureAt: activeFailure?.firstFailureAt ?? now },
    );
  }

  private async verifyAndConsumeBackupCode(user: User, token: string): Promise<boolean> {
    if (!user.totpBackupCodes) {
      return false;
    }

    let codes: string[];
    try {
      const parsed: unknown = JSON.parse(user.totpBackupCodes);
      if (!Array.isArray(parsed) || !parsed.every((code) => typeof code === 'string')) {
        return false;
      }
      codes = parsed;
    } catch {
      return false;
    }

    for (const hashedCode of codes) {
      if (!(await bcrypt.compare(token, hashedCode))) {
        continue;
      }

      const remainingCodes = JSON.stringify(codes.filter((code) => code !== hashedCode));
      const consumed = await this.db
        .update(users)
        .set({ totpBackupCodes: remainingCodes })
        .where(and(eq(users.id, user.id), eq(users.totpBackupCodes, user.totpBackupCodes)))
        .returning({ id: users.id });

      return consumed.length === 1;
    }

    return false;
  }
}
