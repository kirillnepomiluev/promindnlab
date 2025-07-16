import { Column, Entity, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { UserProfile } from './user-profile.entity';

// Запись о движении токенов пользователя
@Entity()
export class TokenTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column({ type: 'int' })
  amount: number;

  @Column()
  type: 'DEBIT' | 'CREDIT';

  @Column({ nullable: true })
  comment?: string;

  // Ссылка на запись о заказе в таблице orders_income
  @Column({ nullable: true })
  orderIncomeId?: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => UserProfile, (user) => user.transactions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserProfile;
}
