import { Test, TestingModule } from '@nestjs/testing';
import { TelegramService } from './telegram.service';
import { getBotToken } from 'nestjs-telegraf';
import { OpenAiService } from '../../openai/openai.service/openai.service';
import { VoiceService } from '../../voice/voice.service/voice.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserProfile } from '../../user/entities/user-profile.entity';
import { UserTokens } from '../../user/entities/user-tokens.entity';
import { TokenTransaction } from '../../user/entities/token-transaction.entity';
import { OrderIncome } from '../../user/entities/order-income.entity';
import { MainUser } from '../../external/entities/main-user.entity';
import { MainOrder } from '../../external/entities/order.entity';
import { MainOrderItem } from '../../external/entities/order-item.entity';
import { ConfigService } from '@nestjs/config';

describe('TelegramService', () => {
  let provider: TelegramService;

  beforeEach(async () => {
    jest
      .spyOn(TelegramService.prototype as any, 'registerHandlers')
      .mockImplementation(() => {});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        {
          provide: getBotToken(),
          useValue: { on: jest.fn(), action: jest.fn(), catch: jest.fn(), telegram: {} },
        },
        { provide: OpenAiService, useValue: {} },
        { provide: VoiceService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => '' } },
        { provide: getRepositoryToken(UserProfile), useValue: {} },
        { provide: getRepositoryToken(UserTokens), useValue: {} },
        { provide: getRepositoryToken(TokenTransaction), useValue: {} },
        { provide: getRepositoryToken(MainUser, 'mainDb'), useValue: {} },
        { provide: getRepositoryToken(MainOrder, 'mainDb'), useValue: {} },
        { provide: getRepositoryToken(MainOrderItem, 'mainDb'), useValue: {} },
        { provide: getRepositoryToken(OrderIncome), useValue: {} },
      ],
    }).compile();

    provider = module.get<TelegramService>(TelegramService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
