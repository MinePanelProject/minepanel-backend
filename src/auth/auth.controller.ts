import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { User } from 'src/db/schema';
import { AuthService, AuthTokens } from './auth.service';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';

type JwtPayload = { sub: string; username: string; role: string };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @ApiOperation({ summary: 'Register a new user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  async register(@Body() createUser: CreateUserDto) {
    await this.authService.registerUser(createUser);

    return {
      message: `User ${createUser.username} created successfully`,
    };
  }

  @Public()
  @ApiOperation({ summary: 'Login and get JWT token' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() loginUser: LoginUserDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.authService.loginUser(loginUser);

    const accessToken = user.accessToken;
    const refreshToken = user.refreshToken;

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes in ms
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    });

    return user.user;
  }

  @ApiOperation({ summary: 'Get profile data' })
  @HttpCode(HttpStatus.OK)
  @Get('profile')
  async profile(@Req() req: Request) {
    return req.user;
  }

  @ApiOperation({ summary: 'Logout and invalidate tokens cookies' })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = req.user as JwtPayload;

    // find token in cookies
    const refreshToken = req.cookies.refresh_token as AuthTokens['refreshToken'];

    // find and delete refresh token db record for the user
    try {
      await this.authService.logoutUser(user.sub, refreshToken);
    } catch (error) {
      Logger.error(error);
    }

    // set both tokens as invalid in cookies
    res.cookie('access_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 0,
    });

    res.cookie('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 0,
    });
  }

  @Public()
  @ApiOperation({ summary: 'Refresh jwt or refresh tokens' })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fetchedRefreshToken = req.cookies.refresh_token as AuthTokens['refreshToken'];
    const newTokens = await this.authService.refreshTokens(fetchedRefreshToken);

    if (!newTokens) {
      throw new UnauthorizedException('Something went wrong when generating new tokens');
    }

    const { accessToken, refreshToken } = newTokens;

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes in ms
    });

    if (refreshToken) {
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
      });
    }
  }

  @ApiOperation({ summary: 'Invalidate all user sessions' })
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = req.user as JwtPayload;

    // find and delete all refresh token db record for the user
    try {
      await this.authService.logoutAll(user.sub);
    } catch (error) {
      Logger.error(error);
    }

    // set both tokens as invalid in cookies
    res.cookie('access_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 0,
    });

    res.cookie('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 0,
    });
  }

  @ApiOperation({ summary: 'List own active sessions (refresh tokens)' })
  @HttpCode(HttpStatus.OK)
  @Get('sessions')
  async getSessions(@Req() req: Request) {
    const user = req.user as JwtPayload;

    try {
      return await this.authService.getSessions(user.sub);
    } catch (error) {
      Logger.error(error);
    }
  }

  @ApiOperation({ summary: 'Revoke a specific session by token id' })
  @HttpCode(HttpStatus.OK)
  @Delete('sessions/:id')
  async deleteSingleSession(@Req() req: Request, @Param('id') tokenId: string) {
    const user = req.user as JwtPayload;

    try {
      await this.authService.deleteSingleSession(user.sub, tokenId);
    } catch (error) {
      Logger.error(error);
    }
  }
}
