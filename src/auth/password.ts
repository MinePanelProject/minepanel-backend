import * as bcrypt from 'bcrypt';

export const compare = (data: string, encrypted: string): Promise<boolean> =>
  bcrypt.compare(data, encrypted);

export const hash = (data: string, saltOrRounds: string | number): Promise<string> =>
  bcrypt.hash(data, saltOrRounds);
