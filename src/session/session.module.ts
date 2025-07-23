import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from '../user/entities/user-profile.entity';
import { SessionService } from './session.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserProfile])],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
