import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { type RequestWithId } from 'src/common/request-id.middleware';
import { type PublicUser } from 'src/users/public-user';
import { AuthService, requireRefreshToken, type TwoFactorChallenge } from './auth.service';
import {
  clearAuthCookies,
  setAccessTokenCookie,
  setAuthCookies,
  setRefreshTokenCookie,
} from './auth-cookies';
import { TwoFactorTokenDto } from './dto/2fa.dto';
import { EditUserDto } from './dto/editUser.dto';
import { LoginUserDto } from './dto/login.dto';
import { CreateOAuthChallengeDto, GoogleCredentialDto } from './dto/oauth.dto';
import { CreateUserDto } from './dto/register.dto';
import { UpdatePasswordDTO } from './dto/updatePw.dto';
import { GoogleOAuthService } from './google-oauth.service';
import { PreAuthGuard, type PreAuthRequest } from './guards/pre-auth.guard';
import { OAuthChallengeService } from './oauth-challenge.service';
import { REFRESH_TOKEN_TTL, type RefreshTokenTtl } from './refresh-token-ttl';

type JwtPayload = { id: string; username: string; role: string; temporaryAuth?: boolean };
type AuthCookieJar = { refresh_token?: string };

type AuthenticatedRequest = RequestWithId & { user: JwtPayload; cookies: AuthCookieJar };
type RefreshRequest = Request & { cookies: AuthCookieJar };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly oauthChallengeService: OAuthChallengeService,
    @Inject(REFRESH_TOKEN_TTL) private readonly refreshTokenTtl: RefreshTokenTtl,
  ) {}
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
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
    @Req() request?: RequestWithId,
  ): Promise<PublicUser | TwoFactorChallenge> {
    const loginResult = await this.authService.loginUser(loginUser, {
      identifier: loginUser.identifier,
      source: request?.ip ?? request?.socket.remoteAddress ?? 'unknown',
    });
    if ('requiresTwoFactor' in loginResult) {
      return loginResult;
    }

    setAuthCookies(res, loginResult, this.refreshTokenTtl);
    return loginResult.user;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @ApiOperation({ summary: 'Create a single-use Google OAuth challenge' })
  @HttpCode(HttpStatus.OK)
  @Post('oauth/challenge')
  async createOAuthChallenge(
    @Body() body: CreateOAuthChallengeDto,
  ): Promise<{ challenge: string }> {
    return { challenge: await this.oauthChallengeService.createChallenge(body.provider) };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @ApiOperation({ summary: 'Sign in with a Google ID token' })
  @HttpCode(HttpStatus.OK)
  @Post('oauth/google/login')
  async loginWithGoogle(
    @Body() body: GoogleCredentialDto,
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ): Promise<PublicUser | { status: 'LinkConfirmationRequired' }> {
    const result = await this.googleOAuthService.login(body.credential);
    if (result.status === 'LinkConfirmationRequired') {
      return result;
    }

    setAuthCookies(res, result.session, this.refreshTokenTtl);
    return result.session.user;
  }

  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @ApiOperation({ summary: 'Link a Google account to the authenticated user' })
  @HttpCode(HttpStatus.OK)
  @Post('oauth/google/link')
  async linkGoogleAccount(
    @Req() req: AuthenticatedRequest,
    @Body() body: GoogleCredentialDto,
  ): Promise<PublicUser> {
    return this.googleOAuthService.linkAuthenticatedUser(req.user.id, body.credential);
  }

  @ApiOperation({ summary: 'Get profile data' })
  @HttpCode(HttpStatus.OK)
  @Get('profile')
  async profile(@Req() req: AuthenticatedRequest) {
    return req.user;
  }

  @ApiOperation({ summary: 'Logout and invalidate tokens cookies' })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ) {
    const user = req.user;

    // find token in cookies; only a string may reach the logout lookup
    const refreshToken = requireRefreshToken(req.cookies.refresh_token);
    await this.authService.logoutUser(user.id, refreshToken);

    // set both tokens as invalid in cookies
    clearAuthCookies(res);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @ApiOperation({ summary: 'Refresh jwt or refresh tokens' })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() req: RefreshRequest,
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ) {
    const rawRefreshToken = requireRefreshToken(req.cookies.refresh_token);
    const newTokens = await this.authService.refreshTokens(rawRefreshToken);

    const { accessToken, refreshToken: rotatedRefreshToken } = newTokens;

    setAccessTokenCookie(res, accessToken);
    setRefreshTokenCookie(res, rotatedRefreshToken, this.refreshTokenTtl);
  }

  @ApiOperation({ summary: 'Invalidate all user sessions' })
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ) {
    const user = req.user;

    // find and delete all refresh token db record for the user
    await this.authService.logoutAll(user.id);

    // set both tokens as invalid in cookies
    clearAuthCookies(res);
  }

  @ApiOperation({ summary: 'List own active sessions (refresh tokens)' })
  @HttpCode(HttpStatus.OK)
  @Get('sessions')
  async getSessions(@Req() req: AuthenticatedRequest) {
    const user = req.user;

    return await this.authService.getSessions(user.id);
  }

  @ApiOperation({ summary: 'Revoke a specific session by token id' })
  @HttpCode(HttpStatus.OK)
  @Delete('sessions/:id')
  async deleteSingleSession(@Req() req: AuthenticatedRequest, @Param('id') tokenId: string) {
    const user = req.user;

    await this.authService.deleteSingleSession(user.id, tokenId);
  }

  @ApiOperation({ summary: 'Update profile (link Minecraft account)' })
  @HttpCode(HttpStatus.OK)
  @Patch('profile')
  async editUserProfile(@Req() req: AuthenticatedRequest, @Body() editUser: EditUserDto) {
    const user = req.user;

    return await this.authService.editUserProfile(user.id, editUser);
  }

  @ApiOperation({ summary: 'Update password' })
  @HttpCode(HttpStatus.OK)
  @Patch('password')
  async updateUserPassword(
    @Req() req: AuthenticatedRequest,
    @Body() updatePw: UpdatePasswordDTO,
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ) {
    const user = req.user;
    const refreshToken = requireRefreshToken(req.cookies.refresh_token);
    const result = await this.authService.updateUserPassword(
      user.id,
      updatePw,
      refreshToken,
      user.temporaryAuth === true,
    );

    if (result.session) {
      setAuthCookies(res, result.session, this.refreshTokenTtl);
    }

    return result.user;
  }

  @ApiOperation({ summary: 'Setup 2FA - generates secret and QR URI' })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/setup')
  async setup2FA(@Req() req: AuthenticatedRequest) {
    const user = req.user;

    return await this.authService.setup2FA(user.id);
  }

  @ApiOperation({ summary: 'Confirm 2FA - verify first TOTP code to activate' })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/confirm')
  async confirm2FA(@Req() req: AuthenticatedRequest, @Body() body: TwoFactorTokenDto) {
    const user = req.user;

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
    @Res({ passthrough: true }) res: Pick<Response, 'cookie'>,
  ): Promise<PublicUser> {
    const preAuth = req.preAuth!;
    const session = preAuth.temporaryAuth
      ? await this.authService.completeTwoFactorLogin(
          preAuth.sub,
          body.token,
          true,
          preAuth.temporaryCredentialFingerprint,
        )
      : await this.authService.completeTwoFactorLogin(preAuth.sub, body.token);
    setAuthCookies(res, session, this.refreshTokenTtl);
    return session.user;
  }

  @ApiOperation({ summary: 'Disable 2FA - requires valid TOTP code' })
  @HttpCode(HttpStatus.OK)
  @Delete('2fa/disable')
  async disable2FA(@Req() req: AuthenticatedRequest, @Body() body: TwoFactorTokenDto) {
    const user = req.user;

    return await this.authService.disable2FA(user.id, body.token);
  }
}
