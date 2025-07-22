import { MigrationInterface, QueryRunner } from 'typeorm';

// Создаёт таблицу token_transaction для учёта списаний и пополнений
export class CreateTokenTransactions1751994655000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "token_transaction" (
        "id" SERIAL PRIMARY KEY,
        "userId" integer NOT NULL REFERENCES "user_profile"("id") ON DELETE CASCADE,
        "amount" integer NOT NULL,
        "type" varchar NOT NULL,
        "comment" varchar,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "token_transaction"`);
  }
}
