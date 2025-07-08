import {
  Column,
  Entity,
  OneToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  OneToMany,
} from 'typeorm';
import { UserTokens } from './user-tokens.entity';
import { TokenTransaction } from './token-transaction.entity';

// Сущность профиля пользователя в Telegram

@Entity()
export class UserProfile {
  @PrimaryGeneratedColumn()
  id: number;

  // Храним ID пользователя как bigint,
  // потому что Telegram выдаёт значения больше 2^31
  // поле telegramId обязательно к заполнению
  @Column({ unique: true, type: 'bigint', nullable: false })
  telegramId: string;

  @Column({ nullable: true })
  firstName?: string;

  @Column({ nullable: true })
  username?: string;

  @Column({ type: 'timestamptz' })
  firstVisitAt: Date;

  @Column({ type: 'timestamptz' })
  lastMessageAt: Date;

  // ID пользователя, который пригласил этого юзера
  @Column({ nullable: true, type: 'bigint' })
  invitedBy?: string;

  @Column({ nullable: true })
  userTokensId: number;

  // Дата начала оплаченного тарифа
  @Column({ type: 'timestamptz', nullable: true })
  dateSubscription?: Date;

  // Дата окончания подписки (30 дней с даты оплаты)
  @Column({ type: 'timestamptz', nullable: true })
  subscriptionUntil?: Date;

  @OneToOne(() => UserTokens, (tokens) => tokens.user, { cascade: true })
  @JoinColumn({ name: 'userTokensId' })
  tokens: UserTokens;

  @OneToMany(() => TokenTransaction, (tx) => tx.user)
  transactions: TokenTransaction[];
}
