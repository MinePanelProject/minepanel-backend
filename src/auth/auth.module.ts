import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { DbModule } from 'src/db/db.module';
import { UsersModule } from 'src/users/users.module';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleOAuthService } from './google-oauth.service';
import {
  GOOGLE_ID_TOKEN_VERIFIER,
  type GoogleIdTokenVerifier,
  GoogleTokenService,
} from './google-token.service';
import { PreAuthGuard } from './guards/pre-auth.guard';
import { IdentityService } from './identity.service';
import { OAuthChallengeService } from './oauth-challenge.service';
import { parseRefreshTokenTtl, REFRESH_TOKEN_TTL } from './refresh-token-ttl';

@Module({
  imports: [
    UsersModule,
    DbModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: REFRESH_TOKEN_TTL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        parseRefreshTokenTtl(configService.get<string>('JWT_REFRESH_EXPIRES_IN')),
    },
    {
      provide: GOOGLE_ID_TOKEN_VERIFIER,
      useFactory: (): GoogleIdTokenVerifier => {
        const client = new OAuth2Client();
        return {
          verifyIdToken: (options) => client.verifyIdToken(options),
        };
      },
    },
    AuthService,
    PreAuthGuard,
    AccessTokenService,
    GoogleOAuthService,
    GoogleTokenService,
    IdentityService,
    OAuthChallengeService,
  ],
  exports: [AccessTokenService, IdentityService, OAuthChallengeService],
})
export class AuthModule {}
