import { Body, Controller, Post } from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() createUser: CreateUserDto): Promise<Omit<User, 'passwordHash'>> {
    return this.authService.registerUser(createUser);
  }
}
