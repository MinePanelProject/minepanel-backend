export const DOCKERODE = Symbol('DOCKERODE');
export const DOCKER_REQUEST_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_SECONDS = 30;
// keep the graceful-stop upper bound below the 60s Dockerode request timeout
// so a valid stop cannot outlive the request and become a false 503
export const MAX_STOP_TIMEOUT_SECONDS = 55;
export const RCON_EXEC_TIMEOUT_MS = 10_000;
export const RCON_MAX_ARG_COUNT = 2;
export const RCON_MAX_TOTAL_BYTES = 256;
