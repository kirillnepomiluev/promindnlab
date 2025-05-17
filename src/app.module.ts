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
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: 'ai_user',
      password: 'ai_pass',
      database: 'ai_bot',
      autoLoadEntities: true,
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
