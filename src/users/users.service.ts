import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Role, User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async createUser(
    email: string,
    username: string,
    passwordHash: string,
    role?: Role,
  ): Promise<Omit<User, 'passwordHash'>> {
    return this.prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        role,
      },
      omit: { passwordHash: true },
    });
  }

  async findById(id: string): Promise<Omit<User, 'passwordHash'> | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { username },
    });
  }
}
