import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramModule } from './telegram/telegram.module';
import { OpenaiModule } from './openai/openai.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        // process.env.NODE_ENV === 'development' ? 'development.env' :
        '.env',
      expandVariables: true,
    }),
    // Подключение к локальной базе данных проекта
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      autoLoadEntities: true,
      synchronize: true,
      // migrations: [__dirname + '/migrations/*{.ts,.js}'],
      // migrationsRun: true,
    }),
    // Подключение к основной базе данных проекта
    TypeOrmModule.forRoot({
      name: 'mainDb',
      type: 'postgres',
      host: process.env.MAIN_DB_HOST,
      port: Number(process.env.MAIN_DB_PORT),
      username: process.env.MAIN_DB_USER,
      password: process.env.MAIN_DB_PASS,
      database: process.env.MAIN_DB_NAME,
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: false,
    }),
    TelegramModule,
    OpenaiModule,
    VoiceModule,
  ],
  //  synchronize: true,
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
