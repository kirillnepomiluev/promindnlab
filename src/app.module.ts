import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramModule } from './telegram/telegram.module';
import { OpenaiModule } from './openai/openai.module';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV === 'development' ? 'development.env' : '.env',
      expandVariables: true,
    }),
    // Подключение к локальной базе данных проекта
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get<string>('DATABASE_HOST'),
        port: Number(cfg.get<string>('DATABASE_PORT')),
        username: cfg.get<string>('DB_USER'),
        password: cfg.get<string>('DB_PASS'),
        database: cfg.get<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: true,
        // migrations: [__dirname + '/migrations/*{.ts,.js}'],
        // migrationsRun: true,
      }),
    }),
    // Подключение к основной базе данных проекта
    TypeOrmModule.forRootAsync({
      name: 'mainDb',
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        host: cfg.get<string>('MAIN_DB_HOST'),
        port: Number(cfg.get<string>('MAIN_DB_PORT')),
        username: cfg.get<string>('MAIN_DB_USER'),
        password: cfg.get<string>('MAIN_DB_PASS'),
        database: cfg.get<string>('MAIN_DB_NAME'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: false,
      }),
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
