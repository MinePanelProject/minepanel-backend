import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UsersService } from 'src/users/users.service';
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
    private prismaService: PrismaService,
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

    const refreshToken = await this.jwtService.signAsync(
      {
        sub: user.id,
      },
      { expiresIn: '7d' },
    );

    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);

    await this.storeRefreshToken(user.id, hashedRefreshToken);

    const { passwordHash, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
    };
  }

  // TODO: update to get userid directly from refresh token
  async logoutUser(user: AuthTokens['user'], refreshToken: AuthTokens['refreshToken']) {
    const storedRefreshTokens = await this.prismaService.refreshToken.findMany({
      where: { userId: user.id },
      select: { id: true, token: true },
    });

    if (storedRefreshTokens.length > 0) {
      for (const tokenEntry of storedRefreshTokens) {
        const matches = await bcrypt.compare(refreshToken, tokenEntry.token);
        if (matches) {
          await this.prismaService.refreshToken.delete({
            where: { id: tokenEntry.id },
          });

          break;
        }
      }
    }
  }

  async storeRefreshToken(userId: string, hashedRefreshToken: string) {
    await this.prismaService.refreshToken.create({
      data: {
        token: hashedRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        user: { connect: { id: userId } },
      },
    });
  }

  async refreshTokens(refreshToken: AuthTokens['refreshToken']) {
    const decodedRefreshToken = await this.jwtService.verifyAsync<{ sub: string }>(refreshToken);
    const userId = decodedRefreshToken.sub;

    const storedRefreshTokens = await this.prismaService.refreshToken.findMany({
      where: { userId },
      select: { id: true, token: true, expiresAt: true },
    });

    // find matching token
    for (const tokenEntry of storedRefreshTokens) {
      const matches = await bcrypt.compare(refreshToken, tokenEntry.token);
      if (!matches) continue;

      const now = new Date();
      const timeRemainingMs = new Date(tokenEntry.expiresAt).getTime() - now.getTime();
      const expiringWithinOneDay = timeRemainingMs <= 86_400_000;

      const user = await this.prismaService.user.findUniqueOrThrow({ where: { id: userId } });

      const newAccessToken = await this.jwtService.signAsync({
        sub: user.id,
        username: user.username,
        role: user.role,
      });

      // case 3
      if (expiringWithinOneDay) {
        await this.prismaService.refreshToken.delete({
          where: {
            id: tokenEntry.id,
          },
        });

        const newRefreshToken = await this.jwtService.signAsync(
          {
            sub: user.id,
          },
          { expiresIn: '7d' },
        );

        const hashedNewRefreshToken = await bcrypt.hash(newRefreshToken, 10);

        await this.storeRefreshToken(user.id, hashedNewRefreshToken);

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
      }

      // case 2
      return { accessToken: newAccessToken };
    }
  }
}
