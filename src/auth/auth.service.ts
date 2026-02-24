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

    const refreshToken = randomBytes(32).toString('hex');
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);

    await this.storeRefreshToken(user.id, hashedRefreshToken);

    const { passwordHash, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
    };
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
}
