import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

type PreAuthPayload = {
  sub: string;
  type: 'pre-auth';
  temporaryAuth?: boolean;
  temporaryCredentialFingerprint?: string;
};
type PreAuthPayloadCandidate = {
  sub?: string;
  type?: string;
  temporaryAuth?: boolean;
  temporaryCredentialFingerprint?: string;
};
type PreAuthRequest = Request & { preAuth?: PreAuthPayload };

const isPreAuthPayload = (payload: PreAuthPayloadCandidate): payload is PreAuthPayload =>
  payload.type === 'pre-auth' &&
  typeof payload.sub === 'string' &&
  payload.sub.trim().length > 0 &&
  (payload.temporaryAuth === undefined || payload.temporaryAuth === true) &&
  (payload.temporaryAuth !== true ||
    /^[\da-f]{64}$/i.test(payload.temporaryCredentialFingerprint ?? '')) &&
  (payload.temporaryAuth === true || payload.temporaryCredentialFingerprint === undefined);

@Injectable()
export class PreAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PreAuthRequest>();
    const authorization = request.headers.authorization;

    const authorizationParts = authorization?.split(' ');
    if (
      !authorizationParts ||
      authorizationParts.length !== 2 ||
      authorizationParts[0].toLowerCase() !== 'bearer' ||
      authorizationParts[1].length === 0 ||
      /\s/.test(authorizationParts[1])
    ) {
      throw new UnauthorizedException();
    }
    const bearerToken = authorizationParts[1];

    try {
      const payload = await this.jwtService.verifyAsync<PreAuthPayloadCandidate>(bearerToken);
      if (!isPreAuthPayload(payload)) {
        throw new UnauthorizedException();
      }

      request.preAuth = payload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException();
    }
  }
}

export type { PreAuthRequest };
