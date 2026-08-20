type TotpVerification = {
  secret: string;
  token: string;
  epochTolerance: number;
};

type Otplib = {
  generateSecret: () => string;
  generateURI: (options: { issuer: string; label: string; secret: string }) => string;
  verifySync: (options: TotpVerification) => { valid: boolean };
};

// SAFETY: otplib's CommonJS runtime exports the three functions consumed by this seam.
const loadOtplib = (): Otplib => require('otplib') as Otplib;
export const generateSecret = (): string => loadOtplib().generateSecret();

export const generateURI = (options: { issuer: string; label: string; secret: string }): string =>
  loadOtplib().generateURI(options);

export const verifySync = (options: TotpVerification): { valid: boolean } =>
  loadOtplib().verifySync(options);
