import { Column, Entity, OneToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { UserTokens } from './user-tokens.entity';

// Сущность профиля пользователя в Telegram

@Entity()
export class UserProfile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  telegramId: number;

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
