import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { CreateUserDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  async registerUser(createUser: CreateUserDto): Promise<Omit<User, 'passwordHash'>> {
    const passwordHash = await bcrypt.hash(createUser.password, 10);
    return this.usersService.createUser(createUser.email, createUser.username, passwordHash);
  }
}
