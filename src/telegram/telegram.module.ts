import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service/telegram.service';
import { OpenaiModule } from 'src/openai/openai.module';
import { VoiceModule } from 'src/voice/voice.module';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from '../user/entities/user-profile.entity';
import { UserTokens } from '../user/entities/user-tokens.entity';

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
    TypeOrmModule.forFeature([UserProfile, UserTokens]),
    OpenaiModule,
    VoiceModule,
  ],
  providers: [TelegramService],
})
export class TelegramModule {}
