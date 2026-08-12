import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { CsrfOriginGuard } from './csrf-origin.guard';

const makeConfig = (corsOrigin: string): ConfigService =>
  new ConfigService({ CORS_ORIGIN: corsOrigin });

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
        ({
          method,
          protocol,
          headers: { origin, host },
          get: (name: string) => (name === 'host' ? host : undefined),
        }) as unknown as Request,
    }),
  }) as unknown as ExecutionContextLike;

type ExecutionContextLike = {
  getType: () => string;
  switchToHttp: () => {
    getRequest: () => Request;
  };
};

const assertForbidden = (call: () => boolean): void => {
  try {
    call();
    throw new Error('expected ForbiddenException');
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    const response = (error as ForbiddenException).getResponse();
    expect(response).toEqual({ error: 'CsrfOriginForbidden' });
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
    const wsContext = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('should not be called');
      },
    } as unknown as ExecutionContextLike;
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
