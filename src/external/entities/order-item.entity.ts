import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Item within an order from the main project
@Entity({ name: 'orders_items' })
export class MainOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number;

  @Column({ nullable: true, name: 'promind_action' })
  promindAction?: 'plus' | 'pro' | 'tokens';
}
