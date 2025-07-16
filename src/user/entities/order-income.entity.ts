import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Записи о подтверждённых заказах из основной системы
@Entity({ name: 'orders_income' })
export class OrderIncome {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  mainOrderId: number;

  @Column()
  userId: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
