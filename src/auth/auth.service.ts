import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { UsersService } from 'src/users/users.service';
import { LoginUserDto } from './dto/login.dto';
import { CreateUserDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  async registerUser(createUser: CreateUserDto): Promise<boolean> {
    const userExists = await this.usersService.findByIdentifier(
      createUser.username || createUser.email,
    );

    if (userExists) {
      throw new ConflictException('User already exists');
    }

    const passwordHash = await bcrypt.hash(createUser.password, 10);
    await this.usersService.createUser(createUser.email, createUser.username, passwordHash);

    return true;
  }

  async loginUser(loginUser: LoginUserDto): Promise<Omit<User, 'passwordHash'> | null> {
    const user = await this.usersService.findByIdentifier(loginUser.identifier);

    if (!user) {
      throw new UnauthorizedException('Wrong credentials');
    }

    const passwordMatches = await bcrypt.compare(loginUser.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Wrong credentials');
    }

    const { passwordHash, ...userWithoutPassword } = user;

    return userWithoutPassword;
  }
}
