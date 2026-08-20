import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { CsrfOriginGuard } from './csrf-origin.guard';

const makeConfig = (corsOrigin: string): ConfigService =>
  new ConfigService({ CORS_ORIGIN: corsOrigin });

// SAFETY: makeContext is the HTTP ExecutionContext producer; its contract invariant supplies
// getType and switchToHttp().getRequest(), the exact members CsrfOriginGuard consumes.
const makeContext = (
  method: string,
  origin: string | string[] | undefined,
  host = 'minepanel.xyz',
  protocol = 'https',
): ExecutionContextLike =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () =>
        /* SAFETY: NestJS request parsing produces method, protocol, headers.origin, headers.host,
        and get('host'), the exact request members CsrfOriginGuard reads. */ ({
          method,
          protocol,
          headers: { origin, host },
          get: (name: string) => (name === 'host' ? host : undefined),
        }) as Request,
    }),
  }) as ExecutionContextLike;

type ExecutionContextLike = ExecutionContext;
type CsrfContextFixture = {
  getType: () => string;
  switchToHttp: () => never;
  getClass?: ExecutionContext['getClass'];
  getHandler?: ExecutionContext['getHandler'];
  getArgs?: ExecutionContext['getArgs'];
  getArgByIndex?: ExecutionContext['getArgByIndex'];
  switchToRpc?: ExecutionContext['switchToRpc'];
  switchToWs?: ExecutionContext['switchToWs'];
};
const asExecutionContext = (fixture: CsrfContextFixture): ExecutionContext =>
  /* SAFETY: NestJS execution-context parsing produces getType and switchToHttp().getRequest(),
  the exact members consumed by CsrfOriginGuard. */ fixture as ExecutionContext;
const assertForbidden = (call: () => boolean): void => {
  try {
    call();
    throw new Error('expected ForbiddenException');
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    // SAFETY: CsrfOriginGuard is the NestJS producer of ForbiddenException; its contract
    // invariant exposes getResponse with the CsrfOriginForbidden payload consumed below.
    const response = error as ForbiddenException;
    expect(response.getResponse()).toEqual({ error: 'CsrfOriginForbidden' });
  }
};

describe('CsrfOriginGuard', () => {
  const guard = new CsrfOriginGuard(makeConfig('https://minepanel.xyz'));

  it('allows mutating requests without an Origin header (non-browser clients)', () => {
    expect(guard.canActivate(makeContext('POST', undefined))).toBe(true);
    expect(guard.canActivate(makeContext('PUT', undefined))).toBe(true);
    expect(guard.canActivate(makeContext('PATCH', undefined))).toBe(true);
    expect(guard.canActivate(makeContext('DELETE', undefined))).toBe(true);
  });

  it('allows mutating requests whose Origin matches the canonical origin exactly', () => {
    expect(guard.canActivate(makeContext('POST', 'https://minepanel.xyz'))).toBe(true);
    expect(guard.canActivate(makeContext('DELETE', 'https://minepanel.xyz'))).toBe(true);
  });

  it('allows same-origin mutating requests (Swagger UI and same-host tools)', () => {
    // API hosted at api.minepanel.xyz: a same-origin caller's Origin matches
    // the request host, not the canonical frontend origin
    expect(
      guard.canActivate(makeContext('POST', 'https://api.minepanel.xyz', 'api.minepanel.xyz')),
    ).toBe(true);
    expect(
      guard.canActivate(makeContext('POST', 'http://127.0.0.1:5173', '127.0.0.1:5173', 'http')),
    ).toBe(true);
    // hostile origin on a different host is still rejected
    assertForbidden(() => guard.canActivate(makeContext('POST', 'https://evil.example')));
  });

  it.each([
    'https://evil.example',
    'null',
    '',
    '   ',
    'https://minepanel.xyz/',
    'https://MINEPANEL.XYZ',
    'https://minepanel.xyz.evil.example',
  ])('rejects mutating requests with hostile Origin %p', (origin) => {
    assertForbidden(() => guard.canActivate(makeContext('POST', origin)));
    assertForbidden(() => guard.canActivate(makeContext('DELETE', origin)));
  });

  it('rejects a repeated (non-string) Origin header', () => {
    assertForbidden(() =>
      guard.canActivate(makeContext('POST', ['https://minepanel.xyz', 'https://evil.example'])),
    );
    assertForbidden(() => guard.canActivate(makeContext('POST', ['https://evil.example'])));
  });

  it('passes read-only and preflight methods through even with a hostile Origin', () => {
    expect(guard.canActivate(makeContext('GET', 'https://evil.example'))).toBe(true);
    expect(guard.canActivate(makeContext('HEAD', 'https://evil.example'))).toBe(true);
    expect(guard.canActivate(makeContext('OPTIONS', 'https://evil.example'))).toBe(true);
  });

  it('passes non-HTTP execution contexts (defensive scope boundary)', () => {
    // SAFETY: the non-HTTP branch reads only getType and never calls switchToHttp.
    const wsContext = asExecutionContext({
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('should not be called');
      },
    });
    expect(guard.canActivate(wsContext)).toBe(true);
  });

  it('derives the canonical origin from configuration', () => {
    const localGuard = new CsrfOriginGuard(makeConfig('http://127.0.0.1:5173'));
    expect(localGuard.canActivate(makeContext('PATCH', 'http://127.0.0.1:5173'))).toBe(true);
    assertForbidden(() =>
      localGuard.canActivate(makeContext('PATCH', 'https://minepanel.xyz', 'api.minepanel.xyz')),
    );
  });
});
