import {
  Column,
  Entity,
  OneToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserTokens } from './user-tokens.entity';

// Сущность профиля пользователя в Telegram

@Entity()
export class UserProfile {
  @PrimaryGeneratedColumn()
  id: number;

  // Храним ID пользователя как bigint,
  // потому что Telegram выдаёт значения больше 2^31
  @Column({ unique: true, type: 'bigint' })
  telegramId: string;

  @Column({ nullable: true })
  firstName?: string;

  @Column({ nullable: true })
  username?: string;

  @Column({ type: 'timestamptz' })
  firstVisitAt: Date;

  @Column({ type: 'timestamptz' })
  lastMessageAt: Date;

  @Column({ nullable: true })
  userTokensId: number;

  @OneToOne(() => UserTokens, (tokens) => tokens.user, { cascade: true })
  @JoinColumn({ name: 'userTokensId' })
  tokens: UserTokens;
}
