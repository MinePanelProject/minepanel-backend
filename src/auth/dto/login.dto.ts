import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class LoginUserDto {
  @ApiProperty()
  @IsNotEmpty()
  identifier: string;

  @ApiProperty()
  @IsNotEmpty()
  password: string;
}
