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
import {
  type AccessType,
  accessTypeEnum,
  type Difficulty,
  DifficultyEnum,
  type Gamemode,
  GamemodeEnum,
  type ServerProvider,
  serverProviderEnum,
} from 'src/db/schema';

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
  provider: ServerProvider;

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

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  maxPlayers?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(DifficultyEnum.enumValues)
  difficulty?: Difficulty;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(GamemodeEnum.enumValues)
  gamemode?: Gamemode;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  pvp?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(512)
  memoryLimitMb?: number;

  @ApiProperty({ required: false })
  @Transform(({ value }) => value?.trim())
  @Transform(({ value }) => value?.replace(/[<>&"]/g, ''))
  @IsOptional()
  @MaxLength(59)
  motd?: string;

  @ApiProperty({ required: false })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @MaxLength(100)
  levelSeed?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  onlineMode?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(32)
  viewDistance?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsIn(accessTypeEnum.enumValues)
  accessType?: AccessType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  allowFlight?: boolean;
}
