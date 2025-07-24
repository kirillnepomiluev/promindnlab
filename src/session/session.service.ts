import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from '../user/entities/user-profile.entity';

@Injectable()
export class SessionService {
  private cache = new Map<number, string>();

  constructor(
    @InjectRepository(UserProfile)
    private readonly profileRepo: Repository<UserProfile>,
  ) {}

  async getSessionId(userId: number): Promise<string | null> {
    const cached = this.cache.get(userId);
    if (cached) {
      return cached;
    }

    const profile = await this.profileRepo.findOne({
      where: { telegramId: String(userId) },
    });
    if (profile?.sessionId) {
      this.cache.set(userId, profile.sessionId);
      return profile.sessionId;
    }

    return null;
  }

  async clearSession(userId: number): Promise<void> {
    this.cache.delete(userId);
    await this.profileRepo.update({ telegramId: String(userId) }, { sessionId: null });
  }

  async setSessionId(userId: number, sessionId: string): Promise<void> {
    this.cache.set(userId, sessionId);
    await this.profileRepo.update({ telegramId: String(userId) }, { sessionId });
  }
}
