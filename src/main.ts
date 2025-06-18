import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from 'dotenv';

// Load environment variables before Nest application bootstrap
config({
  path: process.env.NODE_ENV === 'development' ? 'development.env' : '.env',
  override: true,
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
