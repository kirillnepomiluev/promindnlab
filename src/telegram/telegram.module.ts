import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service/telegram.service';
import { OpenaiModule } from 'src/openai/openai.module';
import { VoiceModule } from 'src/voice/voice.module';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from '../user/entities/user-profile.entity';
import { UserTokens } from '../user/entities/user-tokens.entity';
import { TokenTransaction } from '../user/entities/token-transaction.entity';
import { OrderIncome } from '../user/entities/order-income.entity';
import { MainUser } from '../external/entities/main-user.entity';
import { MainOrder } from '../external/entities/order.entity';

// telegram.module.ts
@Module({
  imports: [
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        token: cfg.get<string>('TELEGRAM_BOT_TOKEN'),
        telegram: { apiRoot: 'https://api.telegram.org', timeout: 120_000 },
      }),
    }),
    // Регистрируем репозитории для локальной и основной БД
    TypeOrmModule.forFeature([UserProfile, UserTokens, TokenTransaction, OrderIncome]),
    TypeOrmModule.forFeature([MainUser, MainOrder], 'mainDb'),
    OpenaiModule,
    VoiceModule,
  ],
  providers: [TelegramService],
})
export class TelegramModule {}
