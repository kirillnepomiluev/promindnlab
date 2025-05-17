import { Test, TestingModule } from '@nestjs/testing';
import { TelegramService } from './telegram.service';

describe('TelegramService', () => {
  let provider: TelegramService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TelegramService],
    }).compile();

    provider = module.get<TelegramService>(TelegramService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
