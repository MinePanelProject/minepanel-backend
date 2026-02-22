import { IsNotEmpty } from 'class-validator';

export class LoginUserDto {
  @IsNotEmpty()
  identifier: string;

  @IsNotEmpty()
  password: string;
}
