import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Минимальная модель пользователя из основного проекта
@Entity({ name: 'users' })
export class MainUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  telegramId: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  username: string;

  // ID пригласившего пользователя из таблицы users
  @Column({ type: 'bigint', nullable: true })
  whoInvitedId: string;

  // Telegram ID пользователя, пригласившего этого юзера
  @Column({ type: 'bigint', nullable: true })
  telegramIdOfReferall: string;
}
