import { ValidateBy, type ValidationOptions } from 'class-validator';
import { isPasswordWithinByteLimit } from '../password';

export const PasswordByteLimit = (validationOptions?: ValidationOptions): PropertyDecorator =>
  ValidateBy(
    {
      name: 'passwordUtf8ByteLimit',
      validator: {
        validate: (value: string): boolean => isPasswordWithinByteLimit(value),
        defaultMessage: () => 'password must not exceed 72 UTF-8 bytes',
      },
    },
    validationOptions,
  );
