import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PromindAction } from '../../constants/promind-action.enum';

// Order record from main project
@Entity({ name: 'orders' })
export class MainOrder {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  status: string;

  @Column()
  totalAmount: number;

  @Column()
  totalPoints: number;

  @Column()
  userId: number;

  @Column({ default: false })
  promind: boolean;

  // Тип действия в Promind: plus, pro или tokens
  @Column({ name: 'promind_action', nullable: true })
  promindAction?: PromindAction;
}
