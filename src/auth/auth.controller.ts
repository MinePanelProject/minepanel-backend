import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiOperation({ summary: 'Register a new user' })
  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  async register(@Body() createUser: CreateUserDto) {
    await this.authService.registerUser(createUser);

    return {
      message: `User ${createUser.username} created successfully`,
    };
  }

  @ApiOperation({ summary: 'Login and get JWT token' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() loginUser: LoginUserDto): Promise<Omit<User, 'passwordHash'> | null> {
    const user = await this.authService.loginUser(loginUser);

    return user;
  }
}
