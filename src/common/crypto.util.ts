import crypto from 'crypto';

export const encrypt = (text: string, key: string) => {
  const iv = crypto.randomBytes(12);

  const keyToBuffer = Buffer.from(key, 'hex');

  const cipher = crypto.createCipheriv('aes-256-gcm', keyToBuffer, iv);

  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};

export const decrypt = (payload: string, key: string) => {
  const [iv, authTag, cipher] = payload.split(':');

  const keyToBuffer = Buffer.from(key, 'hex');
  const ivToBuffer = Buffer.from(iv, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyToBuffer, ivToBuffer);

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  return decipher.update(cipher, 'hex', 'utf8') + decipher.final('utf8');
};
