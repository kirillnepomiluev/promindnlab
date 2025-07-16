import { Column, Entity, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserProfile } from './user-profile.entity';

// Список заказов, приведших к начислению токенов
@Entity({ name: 'orders_income' })
export class OrderIncome {
  @PrimaryGeneratedColumn()
  id: number;

  // ID заказа в основной базе
  @Column()
  orderId: number;

  @Column()
  userId: number;

  // Количество начисленных токенов
  @Column({ type: 'int' })
  tokens: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => UserProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserProfile;
}
