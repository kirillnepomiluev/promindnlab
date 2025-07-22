import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Item of an order from main project
@Entity({ name: 'order_items' })
export class MainOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number;

  @Column({ nullable: true })
  promindAction?: string;
}
