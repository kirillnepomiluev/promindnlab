import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserProfile } from './user-profile.entity';

// Баланс токенов пользователя

@Entity()
export class UserTokens {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ default: 100 })
  tokens: number;

  @Column()
  userId: number;

  @OneToOne(() => UserProfile, (profile) => profile.tokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserProfile;
}
