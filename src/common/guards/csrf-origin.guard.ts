import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { getCanonicalCorsOrigin } from 'src/common/cors-origin';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isSingleOriginHeader = (value: string | readonly string[] | undefined): value is string =>
  typeof value === 'string';

// CSRF defense for cookie-authenticated, credentialed-CORS requests.
//
// Production cookies are SameSite=None (the hosted frontend fetches cross-site),
// so a cross-site HTML form can POST with the victim's cookies — form posts are
// "simple requests" and bypass the CORS preflight entirely. Browsers always
// attach an Origin header to cross-site POSTs, so every mutating request that
// supplies an Origin must present the exact canonical frontend origin — or the
// API's own origin (same-origin calls, e.g. the Swagger UI at /docs); any
// other value (including null, empty, whitespace, malformed, or repeated
// headers) is rejected before authentication runs. Requests without an Origin
// header are non-browser clients (curl, CI, scripts) that cannot be CSRF'd —
// allowed. GET/HEAD/OPTIONS are never state-changing and pass. The Socket.IO
// endpoints are intercepted by the Engine.IO adapter before Nest routing and
// are not guarded here (the adapter enforces its own exact-Origin admission).
@Injectable()
export class CsrfOriginGuard implements CanActivate {
  private readonly canonicalOrigin: string;

  constructor(configService: ConfigService) {
    this.canonicalOrigin = getCanonicalCorsOrigin(configService);
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    if (!MUTATING_METHODS.has(request.method)) {
      return true;
    }

    const origin = request.headers.origin;

    if (origin !== undefined) {
      if (!isSingleOriginHeader(origin) || !this.isAllowedOrigin(request, origin)) {
        throw new ForbiddenException({ error: 'CsrfOriginForbidden' });
      }
    }

    return true;
  }

  private isAllowedOrigin(request: Request, origin: string): boolean {
    if (origin === this.canonicalOrigin) {
      return true;
    }

    // same-origin callers (Swagger UI and other tools hosted on the API host)
    const host = request.get('host');
    const ownOrigin = host === undefined ? undefined : `${request.protocol}://${host}`;
    return ownOrigin !== undefined && origin === ownOrigin;
  }
}
