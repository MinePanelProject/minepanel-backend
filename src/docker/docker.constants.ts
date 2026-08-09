export const DOCKERODE = Symbol('DOCKERODE');
export const DOCKER_REQUEST_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_SECONDS = 30;
// keep the graceful-stop upper bound below the 60s Dockerode request timeout
// so a valid stop cannot outlive the request and become a false 503
export const MAX_STOP_TIMEOUT_SECONDS = 55;
