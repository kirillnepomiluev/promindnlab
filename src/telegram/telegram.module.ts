import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service/telegram.service';
import { OpenaiModule } from 'src/openai/openai.module';
import { VoiceModule } from 'src/voice/voice.module';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';

// telegram.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // .env грузится глобально
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        token: cfg.get<string>('TELEGRAM_BOT_TOKEN'),
        telegram: { apiRoot: 'https://api.telegram.org', timeout: 120_000 },
      }),
    }),
    OpenaiModule,
    VoiceModule,
  ],
  providers: [TelegramService],
})
export class TelegramModule {}
