import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @HttpCode(201)
  @Post('register')
  async register(@Body() createUser: CreateUserDto) {
    await this.authService.registerUser(createUser);

    return {
      message: `User ${createUser.username} created successfully`,
    };
  }

  @HttpCode(200)
  @Post('login')
  async login(@Body() loginUser: LoginUserDto): Promise<Omit<User, 'passwordHash'> | null> {
    const user = await this.authService.loginUser(loginUser);

    return user;
  }
}
