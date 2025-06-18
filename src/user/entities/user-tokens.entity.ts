import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserProfile } from './user-profile.entity';

// Баланс токенов пользователя

@Entity()
export class UserTokens {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 100 })
  tokens: number;

  // Тарифный план пользователя: LITE или PRO
  @Column({ nullable: true })
  plan?: 'LITE' | 'PRO';

  // Ожидаемый тип платежа: LITE, PRO или TOPUP
  @Column({ nullable: true })
  pendingPayment?: 'LITE' | 'PRO' | 'TOPUP';

  @Column()
  userId: number;

  @OneToOne(() => UserProfile, (profile) => profile.tokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserProfile;
}
