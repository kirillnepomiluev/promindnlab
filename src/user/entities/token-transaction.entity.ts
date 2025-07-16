import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { UserProfile } from './user-profile.entity';
import { OrderIncome } from './order-income.entity';

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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ nullable: true })
  orderIncomeId?: number;

  @ManyToOne(() => UserProfile, (user) => user.transactions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserProfile;

  @ManyToOne(() => OrderIncome, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'orderIncomeId' })
  orderIncome?: OrderIncome;
}
