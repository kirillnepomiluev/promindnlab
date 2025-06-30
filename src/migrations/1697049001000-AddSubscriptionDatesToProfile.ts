import { MigrationInterface, QueryRunner } from 'typeorm';

// Добавляет поля dateSubscription и subscriptionUntil в user_profile
export class AddSubscriptionDatesToProfile1697049001000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_profile" ADD "dateSubscription" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "user_profile" ADD "subscriptionUntil" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "subscriptionUntil"`);
    await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "dateSubscription"`);
  }
}
