import { MigrationInterface, QueryRunner } from 'typeorm';

// Миграция добавляет ограничение NOT NULL для поля telegramId
export class UserProfileTelegramIdNotNull1697049000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Удаляем или обновляем записи без telegramId. Проще всего удалить
    await queryRunner.query(`DELETE FROM "user_profile" WHERE "telegramId" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "user_profile" ALTER COLUMN "telegramId" SET NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Возвращаем возможность хранить NULL
    await queryRunner.query(
      `ALTER TABLE "user_profile" ALTER COLUMN "telegramId" DROP NOT NULL`
    );
  }
}
