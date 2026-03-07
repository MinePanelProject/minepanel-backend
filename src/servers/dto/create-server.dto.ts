import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DifficultyEnum, GamemodeEnum, serverProviderEnum } from 'src/db/schema';

export class CreateServerDto {
  @ApiProperty()
  @Transform(({ value }) => value?.trim())
  @Transform(({ value }) => value?.replace(/[<>&"]/g, ''))
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @ApiProperty()
  @IsIn(serverProviderEnum.enumValues)
  @IsNotEmpty()
  provider: string;

  @ApiProperty()
  @Transform(({ value }) => value?.trim())
  @IsNotEmpty()
  @Matches(/^\d+\.\d+(\.\d+)?$/)
  version: string;

  @ApiProperty()
  @IsInt()
  @Min(25565)
  @Max(25665)
  @IsNotEmpty()
  port: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  maxPlayers: number;

  @ApiProperty()
  @IsOptional()
  @IsIn(DifficultyEnum.enumValues)
  difficulty: string;

  @ApiProperty()
  @IsOptional()
  @IsIn(GamemodeEnum.enumValues)
  gamemode: string;

  @ApiProperty()
  @IsOptional()
  @IsBoolean()
  pvp: boolean;

  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(512)
  memoryLimitMb: number;

  @ApiProperty()
  @Transform(({ value }) => value?.trim())
  @Transform(({ value }) => value?.replace(/[<>&"]/g, ''))
  @IsOptional()
  @MaxLength(59)
  motd: string;

  @ApiProperty()
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @MaxLength(100)
  levelSeed: string;

  @ApiProperty()
  @IsOptional()
  @IsBoolean()
  onlineMode: boolean;

  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(32)
  viewDistance: number;

  @ApiProperty()
  @IsOptional()
  @IsBoolean()
  allowFlight: boolean;
}
