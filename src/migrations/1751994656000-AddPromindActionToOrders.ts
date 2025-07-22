import { MigrationInterface, QueryRunner } from 'typeorm';

// Добавляет поле promind_action в таблицу orders
export class AddPromindActionToOrders1751994656000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD "promind_action" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "promind_action"`);
  }
}
