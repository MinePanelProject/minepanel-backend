import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from 'src/db/db.module';
import { RefreshToken, refreshTokens, type User, users } from 'src/db/schema';
import { UsersService } from 'src/users/users.service';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';

export interface AuthTokens {
  user: Omit<User, 'passwordHash'>;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private jwtService: JwtService,
    @Inject(DRIZZLE) private db: DrizzleDB,
  ) {}

  async registerUser(createUser: CreateUserDto): Promise<boolean> {
    const userExists = await this.usersService.findByIdentifier(
      createUser.username || createUser.email,
    );

    if (userExists) {
      throw new ConflictException('User already exists');
    }

    const passwordHash = await bcrypt.hash(createUser.password, 10);
    await this.usersService.createUser(createUser.email, createUser.username, passwordHash);

    return true;
  }

  async loginUser(loginUser: LoginUserDto): Promise<AuthTokens> {
    const user = await this.usersService.findByIdentifier(loginUser.identifier);

    if (!user) {
      throw new UnauthorizedException('Wrong credentials');
    }

    const passwordMatches = await bcrypt.compare(loginUser.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Wrong credentials');
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

      const timeRemainingMs = new Date(tokenEntry.expiresAt).getTime() - Date.now();
      const expiringWithinOneDay = timeRemainingMs <= 86_400_000;

      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) throw new UnauthorizedException();

      const newAccessToken = await this.jwtService.signAsync({
        sub: user.id,
        username: user.username,
        role: user.role,
      });

      if (expiringWithinOneDay) {
        await this.db.delete(refreshTokens).where(eq(refreshTokens.id, tokenEntry.id));

        const newRefreshToken = await this.jwtService.signAsync(
          { sub: user.id },
          { expiresIn: '7d' },
        );

        const hashedNew = await bcrypt.hash(newRefreshToken, 10);
        await this.storeRefreshToken(user.id, hashedNew);

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
      }

      return { accessToken: newAccessToken };
    }
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
}
