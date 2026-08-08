import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { type PublicUser } from 'src/users/public-user';
import { AuthService, type AuthTokens, type TwoFactorChallenge } from './auth.service';
import { TwoFactorTokenDto } from './dto/2fa.dto';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';
import { PreAuthGuard, type PreAuthRequest } from './guards/pre-auth.guard';

type JwtPayload = { id: string; username: string; role: string };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10000 } })
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
  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @ApiOperation({ summary: 'Login and get JWT token' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() loginUser: LoginUserDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser | TwoFactorChallenge> {
    const loginResult = await this.authService.loginUser(loginUser);

    if ('requiresTwoFactor' in loginResult) {
      return loginResult;
    }

    this.setAuthCookies(res, loginResult);
    return loginResult.user;
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
    await this.authService.logoutUser(user.id, refreshToken);

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
  @Throttle({ default: { limit: 5, ttl: 10000 } })
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
    await this.authService.logoutAll(user.id);

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

    return await this.authService.getSessions(user.id);
  }

  @ApiOperation({ summary: 'Revoke a specific session by token id' })
  @HttpCode(HttpStatus.OK)
  @Delete('sessions/:id')
  async deleteSingleSession(@Req() req: Request, @Param('id') tokenId: string) {
    const user = req.user as JwtPayload;

    await this.authService.deleteSingleSession(user.id, tokenId);
  }

  @ApiOperation({ summary: 'Update profile (link Minecraft account)' })
  @HttpCode(HttpStatus.OK)
  @Patch('profile')
  async editUserProfile(@Req() req: Request, @Body() editUser: EditUserDto) {
    const user = req.user as JwtPayload;

    return await this.authService.editUserProfile(user.id, editUser);
  }

  @ApiOperation({ summary: 'Update password' })
  @HttpCode(HttpStatus.OK)
  @Patch('password')
  async updateUserPassword(@Req() req: Request, @Body() updatePw: UpdatePasswordDTO) {
    const user = req.user as JwtPayload;

    const refreshToken = req.cookies.refresh_token as AuthTokens['refreshToken'];

    return await this.authService.updateUserPassword(user.id, updatePw, refreshToken);
  }

  @ApiOperation({ summary: 'Setup 2FA - generates secret and QR URI' })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/setup')
  async setup2FA(@Req() req: Request) {
    const user = req.user as JwtPayload;

    return await this.authService.setup2FA(user.id);
  }

  @ApiOperation({ summary: 'Confirm 2FA - verify first TOTP code to activate' })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/confirm')
  async confirm2FA(@Req() req: Request, @Body() body: TwoFactorTokenDto) {
    const user = req.user as JwtPayload;

    return await this.authService.confirm2FA(user.id, body.token);
  }

  @Public()
  @UseGuards(PreAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * 60 * 1000 } })
  @ApiOperation({ summary: 'Verify 2FA challenge and issue a session' })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/verify')
  async verify2FA(
    @Req() req: PreAuthRequest,
    @Body() body: TwoFactorTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const session = await this.authService.completeTwoFactorLogin(req.preAuth!.sub, body.token);
    this.setAuthCookies(res, session);
    return session.user;
  }

  @ApiOperation({ summary: 'Disable 2FA - requires valid TOTP code' })
  @HttpCode(HttpStatus.OK)
  @Delete('2fa/disable')
  async disable2FA(@Req() req: Request, @Body() body: TwoFactorTokenDto) {
    const user = req.user as JwtPayload;

    return await this.authService.disable2FA(user.id, body.token);
  }
  private setAuthCookies(res: Response, tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken'>) {
    res.cookie('access_token', tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}
