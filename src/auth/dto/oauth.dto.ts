import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOAuthChallengeDto {
  @ApiProperty({ enum: ['google'] })
  @IsString()
  @IsIn(['google'])
  provider: 'google';
}

export class GoogleCredentialDto {
  @ApiProperty({ description: 'Google OpenID Connect ID token' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  credential: string;
}
