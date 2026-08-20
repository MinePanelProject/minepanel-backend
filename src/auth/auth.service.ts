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
import { and, eq, getTableColumns, gt } from 'drizzle-orm';
import { decrypt, encrypt } from 'src/common/crypto.util';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { RefreshToken, refreshTokens, type User, users } from 'src/db/schema';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';
import * as bcrypt from './password';
import { generateSecret, generateURI, verifySync } from './totp';

type AuthDatabase = Pick<DrizzleDB, 'insert' | 'update' | 'select' | 'delete'>;
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_FACTOR_FAILURE_LIMIT = 5;
const TWO_FACTOR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const TWO_FACTOR_LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = '$2b$10$ImDussfxY6I73mT10z0lU.DyrhBuXdRh7CBiLNf0nJM3yNj1asche';
const TOTP_WINDOW_SECONDS = 30;

type JsonScalar = string | number | boolean | null | undefined;
type BackupCodeArrayCandidate = JsonScalar[];

const isStringScalar = (value: JsonScalar): value is string => typeof value === 'string';

const isStringArray = (value: BackupCodeArrayCandidate): value is string[] =>
  Array.isArray(value) && value.every(isStringScalar);

export interface AuthTokens {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export type TwoFactorChallenge = { requiresTwoFactor: true; preAuthToken: string };
export type LoginResponse = AuthTokens | TwoFactorChallenge;

type TwoFactorFailure = { failures: number; firstFailureAt: number; lockedUntil?: number };
type PasswordUpdateResult = { user: PublicUser; session?: AuthTokens };
type AccessTokenClaims = {
  sub: string;
  type: 'access';
  username: string;
  role: string;
  temporaryAuth?: boolean;
};
type RefreshTokenClaims = { sub: string; type: 'refresh'; temporaryAuth?: boolean };

@Injectable()
export class AuthService {
  private readonly encryptionKey: string;
  private readonly twoFactorFailures = new Map<string, TwoFactorFailure>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: AuthDatabase,
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

    // Always run exactly two bcrypt comparisons so timing does not reveal
    // whether the account exists or currently holds a temporary reset.
    const primaryHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const primaryMatches = await bcrypt.compare(loginUser.password, primaryHash);

    const tempHash =
      user?.tempPasswordHash &&
      user.tempPasswordExpiresAt &&
      user.tempPasswordExpiresAt.getTime() > Date.now()
        ? user.tempPasswordHash
        : DUMMY_PASSWORD_HASH;
    const tempMatches = await bcrypt.compare(loginUser.password, tempHash);

    if (!user || (!primaryMatches && !tempMatches)) {
      throw new UnauthorizedException('Wrong credentials');
    }

    this.assertLoginAllowed(user);

    // While forced recovery is active the temporary credential is the only
    // credential that may start a session; a matching primary password gets
    // the same generic failure as any other wrong password.
    if (user.mustChangePassword) {
      if (!tempMatches) {
        throw new UnauthorizedException('Wrong credentials');
      }

      if (user.totpEnabled) {
        const preAuthToken = await this.jwtService.signAsync(
          {
            sub: user.id,
            type: 'pre-auth',
            temporaryAuth: true,
            temporaryCredentialFingerprint: crypto
              .createHash('sha256')
              .update(user.tempPasswordHash!)
              .digest('hex'),
          },
          { expiresIn: '5m' },
        );

        return { requiresTwoFactor: true, preAuthToken };
      }

      await this.consumeTempPassword(user);
      return this.issueSession(user, true);
    }

    if (primaryMatches) {
      if (user.totpEnabled) {
        const preAuthToken = await this.jwtService.signAsync(
          { sub: user.id, type: 'pre-auth' },
          { expiresIn: '5m' },
        );

        return { requiresTwoFactor: true, preAuthToken };
      }

      return this.issueSession(user);
    }

    throw new UnauthorizedException('Wrong credentials');
  }

  async completeTwoFactorLogin(
    userId: string,
    token: string,
    temporaryAuth = false,
    temporaryCredentialFingerprint?: string,
  ): Promise<AuthTokens> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException();
    }

    this.assertLoginAllowed(user);
    this.assertTwoFactorNotLocked(user.id);

    // a completed 2FA flow must match the account's current recovery state:
    // a stale normal pre-auth challenge cannot finish after an admin reset
    if (user.mustChangePassword !== temporaryAuth) {
      throw new UnauthorizedException();
    }

    // bind a temporary flow to the exact credential that was matched at login
    // before any 2FA failure accounting or backup-code mutation, so a pre-auth
    // token invalidated by a newer reset or by consumption can neither lock
    // recovery nor burn a backup code
    if (
      temporaryAuth &&
      (!temporaryCredentialFingerprint ||
        !user.tempPasswordHash ||
        !user.tempPasswordExpiresAt ||
        user.tempPasswordExpiresAt.getTime() <= Date.now() ||
        crypto.createHash('sha256').update(user.tempPasswordHash).digest('hex') !==
          temporaryCredentialFingerprint)
    ) {
      throw new UnauthorizedException();
    }

    const isValidTotp = this.isValidTotp(user, token);
    const usedBackupCode = isValidTotp ? false : await this.verifyAndConsumeBackupCode(user, token);

    if (!isValidTotp && !usedBackupCode) {
      this.recordTwoFactorFailure(user.id);
      throw new UnauthorizedException('Invalid two-factor code');
    }

    this.twoFactorFailures.delete(user.id);
    if (temporaryAuth) {
      await this.consumeTempPassword(user);
    }

    return this.issueSession(user, temporaryAuth);
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
    const decoded = await this.jwtService.verifyAsync<{
      sub: string;
      type?: string;
      temporaryAuth?: boolean;
    }>(refreshToken);

    // the token type pins its purpose: only a refresh token may rotate
    if (decoded.type !== 'refresh') {
      throw new UnauthorizedException();
    }

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
      // the token origin must match the account's current recovery state even
      // when a stale matching refresh row still exists in the database
      if (!user || user.mustChangePassword !== (decoded.temporaryAuth === true)) {
        throw new UnauthorizedException();
      }

      const temporaryAuth = decoded.temporaryAuth === true;
      const accessClaims: AccessTokenClaims = {
        sub: user.id,
        type: 'access',
        username: user.username,
        role: user.role,
      };
      const refreshClaims: RefreshTokenClaims = { sub: user.id, type: 'refresh' };
      if (temporaryAuth) {
        accessClaims.temporaryAuth = true;
        refreshClaims.temporaryAuth = true;
      }
      const newAccessToken = await this.jwtService.signAsync(accessClaims);

      await this.db.delete(refreshTokens).where(eq(refreshTokens.id, tokenEntry.id));

      const newRefreshToken = await this.jwtService.signAsync(refreshClaims, { expiresIn: '7d' });
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
    temporaryAuth = false,
  ): Promise<PasswordUpdateResult> {
    const user = await this.usersService.updatePassword(userId, dto, refreshToken, temporaryAuth);

    if (!temporaryAuth) {
      return { user };
    }

    const updatedUser = await this.usersService.findById(userId);
    if (!updatedUser) {
      throw new UnauthorizedException();
    }

    const session = await this.issueSession(updatedUser);
    return { user: session.user, session };
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

  private async issueSession(user: User, temporaryAuth = false): Promise<AuthTokens> {
    const accessClaims: AccessTokenClaims = {
      sub: user.id,
      type: 'access',
      username: user.username,
      role: user.role,
    };
    const refreshClaims: RefreshTokenClaims = { sub: user.id, type: 'refresh' };
    if (temporaryAuth) {
      accessClaims.temporaryAuth = true;
      refreshClaims.temporaryAuth = true;
    }
    const accessToken = await this.jwtService.signAsync(accessClaims);
    const refreshToken = await this.jwtService.signAsync(refreshClaims, { expiresIn: '7d' });

    await this.storeRefreshToken(user.id, await bcrypt.hash(refreshToken, 10));

    return { user: toPublicUser(user), accessToken, refreshToken };
  }

  private async consumeTempPassword(user: User): Promise<void> {
    if (!user.tempPasswordHash || !user.tempPasswordExpiresAt) {
      throw new UnauthorizedException('Wrong credentials');
    }

    const [consumed] = await this.db
      .update(users)
      .set({ tempPasswordExpiresAt: null })
      .where(
        and(
          eq(users.id, user.id),
          eq(users.mustChangePassword, true),
          eq(users.tempPasswordHash, user.tempPasswordHash),
          gt(users.tempPasswordExpiresAt, new Date()),
        ),
      )
      .returning({ id: users.id });

    if (!consumed) {
      throw new UnauthorizedException('Wrong credentials');
    }
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
      const parsed: BackupCodeArrayCandidate = JSON.parse(user.totpBackupCodes);
      if (!isStringArray(parsed)) {
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
