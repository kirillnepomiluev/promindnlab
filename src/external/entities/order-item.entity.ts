import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Item of an order from main project
@Entity({ name: 'order_items' })
export class MainOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  orderId: number;

  // Flag for promind action encoded in main DB
  @Column({ name: 'promind_action', nullable: true })
  promindAction?: string;
}
