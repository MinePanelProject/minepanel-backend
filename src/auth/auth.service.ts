import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { and, eq, getTableColumns, gt, lte } from 'drizzle-orm';
import { decrypt, encrypt } from 'src/common/crypto.util';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import {
  type NewRefreshToken,
  type RefreshToken,
  refreshTokens,
  type User,
  users,
} from 'src/db/schema';
import { type PublicUser, toPublicUser } from 'src/users/public-user';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';
import { LoginAbuseService, type LoginAttemptContext } from './login-abuse.service';
import * as bcrypt from './password';
import { createRefreshTokenId, hashRefreshTokenId } from './refresh-token-id';
import { REFRESH_TOKEN_TTL, type RefreshTokenTtl } from './refresh-token-ttl';
import { generateSecret, generateURI, verifySync } from './totp';

type AuthDatabase = Pick<DrizzleDB, 'insert' | 'update' | 'select' | 'delete' | 'transaction'>;
const MAX_EXP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
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
type RefreshTokenSigningClaims = {
  sub: string;
  type: 'refresh';
  jti: string;
  temporaryAuth?: boolean;
};
type RefreshTokenClaims = RefreshTokenSigningClaims & { exp: number };

type RefreshTokenClaimsCandidate = {
  sub?: unknown;
  type?: unknown;
  jti?: unknown;
  temporaryAuth?: unknown;
  exp?: unknown;
};
type RefreshTokenErrorCode =
  | 'RefreshTokenMissing'
  | 'RefreshTokenMalformed'
  | 'RefreshTokenExpired'
  | 'TokenWrongPurpose'
  | 'RefreshTokenInvalid';
type IssuedRefreshToken = {
  refreshToken: string;
  row: NewRefreshToken;
};

const isRefreshToken = (candidate: unknown): candidate is string =>
  typeof candidate === 'string' && candidate.length > 0;

export const refreshTokenUnauthorized = (code: RefreshTokenErrorCode): UnauthorizedException =>
  new UnauthorizedException({ error: code });

export const requireRefreshToken = (value: string | undefined): string => {
  if (value === undefined) {
    throw refreshTokenUnauthorized('RefreshTokenMissing');
  }

  if (!isRefreshToken(value)) {
    throw refreshTokenUnauthorized('RefreshTokenMalformed');
  }

  return value;
};

export const readRefreshTokenId = (refreshToken: string): string => {
  const segment = refreshToken.split('.')[1];
  if (!segment) {
    throw refreshTokenUnauthorized('RefreshTokenMalformed');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw refreshTokenUnauthorized('RefreshTokenMalformed');
  }

  if (!isValidRefreshTokenClaims(payload)) {
    throw refreshTokenUnauthorized('RefreshTokenInvalid');
  }

  return payload.jti;
};

const isExpiredJwtError = (error: unknown): error is { name: string } => {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }

  return error.name === 'TokenExpiredError';
};

const isRefreshTypedPayload = (payload: unknown): payload is { type: unknown } =>
  typeof payload === 'object' && payload !== null && 'type' in payload;
const isRefreshTokenClaimsCandidate = (
  candidate: unknown,
): candidate is RefreshTokenClaimsCandidate => {
  try {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const isValidRefreshTokenClaims = (candidate: unknown): candidate is RefreshTokenClaims => {
  if (!isRefreshTokenClaimsCandidate(candidate)) {
    return false;
  }

  const claims = candidate;
  if (
    !Object.hasOwn(claims, 'sub') ||
    !Object.hasOwn(claims, 'type') ||
    !Object.hasOwn(claims, 'jti') ||
    !Object.hasOwn(claims, 'exp')
  ) {
    return false;
  }

  const { sub, type, jti, exp } = claims;
  const temporaryAuth = Object.hasOwn(claims, 'temporaryAuth') ? claims.temporaryAuth : undefined;

  return (
    typeof sub === 'string' &&
    sub.length > 0 &&
    type === 'refresh' &&
    typeof jti === 'string' &&
    jti.length > 0 &&
    (temporaryAuth === undefined || typeof temporaryAuth === 'boolean') &&
    typeof exp === 'number' &&
    Number.isFinite(exp) &&
    exp > 0 &&
    exp <= MAX_EXP_SECONDS
  );
};

@Injectable()
export class AuthService {
  private readonly encryptionKey: string;
  private readonly twoFactorFailures = new Map<string, TwoFactorFailure>();

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(DRIZZLE) private readonly db: AuthDatabase,
    private readonly configService: ConfigService,
    @Inject(REFRESH_TOKEN_TTL) private readonly refreshTokenTtl: RefreshTokenTtl,
    @Optional() private readonly loginAbuseService?: LoginAbuseService,
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

    bcrypt.assertPasswordWithinByteLimit(createUser.password);
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

  async loginUser(loginUser: LoginUserDto, context?: LoginAttemptContext): Promise<LoginResponse> {
    if (context && this.loginAbuseService) {
      await this.loginAbuseService.assertAllowed(context);
    }
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

    if (!bcrypt.isPasswordWithinByteLimit(loginUser.password) || !user) {
      this.recordLoginFailure(context);
      throw new UnauthorizedException('Wrong credentials');
    }

    this.assertLoginAllowed(user);

    // While forced recovery is active the temporary credential is the only
    // credential that may start a session; a matching primary password gets
    // the same generic failure as any other wrong password.
    if (user.mustChangePassword) {
      if (!tempMatches) {
        this.recordLoginFailure(context);
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

        this.recordLoginSuccess(context);
        return { requiresTwoFactor: true, preAuthToken };
      }

      await this.consumeTempPassword(user);
      const session = await this.issueSession(user, true);
      this.recordLoginSuccess(context);
      return session;
    }

    if (primaryMatches) {
      if (user.totpEnabled) {
        const preAuthToken = await this.jwtService.signAsync(
          { sub: user.id, type: 'pre-auth' },
          { expiresIn: '5m' },
        );

        this.recordLoginSuccess(context);
        return { requiresTwoFactor: true, preAuthToken };
      }

      const session = await this.issueSession(user);
      this.recordLoginSuccess(context);
      return session;
    }

    this.recordLoginFailure(context);
    throw new UnauthorizedException('Wrong credentials');
  }

  async issueProviderSession(user: User): Promise<AuthTokens> {
    this.assertLoginAllowed(user);

    if (user.mustChangePassword) {
      throw new ForbiddenException({ error: 'PasswordRecoveryRequired' });
    }

    if (user.totpEnabled) {
      throw new ForbiddenException({ error: 'TwoFactorAuthenticationRequired' });
    }

    return this.issueSession(user);
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
    const tokenId = readRefreshTokenId(refreshToken);
    await this.db
      .delete(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.tokenIdHash, hashRefreshTokenId(tokenId)),
        ),
      );
  }

  async logoutAll(userId: string) {
    await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }

  async refreshTokens(rawRefreshToken: string) {
    let verifiedClaims: unknown;
    try {
      verifiedClaims = await this.jwtService.verifyAsync(rawRefreshToken);
    } catch (error) {
      if (isExpiredJwtError(error)) {
        throw refreshTokenUnauthorized('RefreshTokenExpired');
      }
      throw refreshTokenUnauthorized('RefreshTokenInvalid');
    }

    if (!isValidRefreshTokenClaims(verifiedClaims)) {
      throw refreshTokenUnauthorized(
        isRefreshTypedPayload(verifiedClaims) && verifiedClaims.type !== 'refresh'
          ? 'TokenWrongPurpose'
          : 'RefreshTokenMalformed',
      );
    }
    const decoded = verifiedClaims;
    const userId = decoded.sub;

    return await this.db.transaction(async (tx) => {
      const [stored] = await tx
        .select({ id: refreshTokens.id, expiresAt: refreshTokens.expiresAt })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenIdHash, hashRefreshTokenId(decoded.jti)))
        .limit(1);

      if (!stored || stored.expiresAt.getTime() <= Date.now()) {
        throw refreshTokenUnauthorized('RefreshTokenExpired');
      }

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for('update');
      // the token origin must match the account's current recovery state even
      // when a stale matching refresh row still exists in the database
      if (!user || user.mustChangePassword !== (decoded.temporaryAuth === true)) {
        throw refreshTokenUnauthorized('RefreshTokenInvalid');
      }

      this.assertLoginAllowed(user);

      const temporaryAuth = decoded.temporaryAuth === true;
      const accessClaims: AccessTokenClaims = {
        sub: user.id,
        type: 'access',
        username: user.username,
        role: user.role,
      };
      const refreshClaims: RefreshTokenSigningClaims = {
        sub: user.id,
        type: 'refresh',
        jti: createRefreshTokenId(),
      };
      if (temporaryAuth) {
        accessClaims.temporaryAuth = true;
        refreshClaims.temporaryAuth = true;
      }
      const accessToken = await this.jwtService.signAsync(accessClaims);

      const [consumed] = await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.id, stored.id))
        .returning({ id: refreshTokens.id });

      if (!consumed) {
        throw refreshTokenUnauthorized('RefreshTokenInvalid');
      }

      const issued = await this.buildIssuedRefreshToken(user.id, refreshClaims);
      await tx.insert(refreshTokens).values(issued.row);

      // lazy per-user sweep: the expired rows cost nothing to remove inside
      // the rotation transaction and keep GET /sessions and future lookups lean
      await tx
        .delete(refreshTokens)
        .where(and(eq(refreshTokens.userId, userId), lte(refreshTokens.expiresAt, new Date())));

      return { accessToken, refreshToken: issued.refreshToken };
    });
  }

  async getSessions(userId: string): Promise<Omit<RefreshToken, 'token' | 'tokenIdHash'>[]> {
    // tokenIdHash is a credential-bound value: never project it to the client
    const { tokenIdHash: _tokenIdHash, ...sessionColumns } = getTableColumns(refreshTokens);

    return this.db
      .select(sessionColumns)
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), gt(refreshTokens.expiresAt, new Date())));
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
    const refreshTokenId = readRefreshTokenId(refreshToken);
    const user = await this.usersService.updatePassword(
      userId,
      dto,
      temporaryAuth ? undefined : refreshTokenId,
      temporaryAuth,
    );

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
    const refreshClaims: RefreshTokenSigningClaims = {
      sub: user.id,
      type: 'refresh',
      jti: createRefreshTokenId(),
    };
    if (temporaryAuth) {
      accessClaims.temporaryAuth = true;
      refreshClaims.temporaryAuth = true;
    }
    const accessToken = await this.jwtService.signAsync(accessClaims);
    const issued = await this.buildIssuedRefreshToken(user.id, refreshClaims);
    await this.db.insert(refreshTokens).values(issued.row);

    return { user: toPublicUser(user), accessToken, refreshToken: issued.refreshToken };
  }

  private async buildIssuedRefreshToken(
    userId: string,
    refreshClaims: RefreshTokenSigningClaims,
  ): Promise<IssuedRefreshToken> {
    const refreshToken = await this.jwtService.signAsync(refreshClaims, {
      expiresIn: this.refreshTokenTtl.expiresIn,
    });

    return {
      refreshToken,
      row: {
        tokenIdHash: hashRefreshTokenId(refreshClaims.jti),
        userId,
        expiresAt: new Date(Date.now() + this.refreshTokenTtl.milliseconds),
      },
    };
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

  private recordLoginFailure(context: LoginAttemptContext | undefined): void {
    if (context && this.loginAbuseService) this.loginAbuseService.recordFailure(context);
  }

  private recordLoginSuccess(context: LoginAttemptContext | undefined): void {
    if (context && this.loginAbuseService) this.loginAbuseService.recordSuccess(context);
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
    if (!/^\d{6}$/u.test(token)) {
      return false;
    }

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
      const parsed = JSON.parse(user.totpBackupCodes);
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
