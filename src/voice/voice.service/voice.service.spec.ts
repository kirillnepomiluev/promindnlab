import { Test, TestingModule } from '@nestjs/testing';
import { VoiceService } from './voice.service';
import { ConfigService } from '@nestjs/config';
import { getBotToken } from 'nestjs-telegraf';
import { DEFAULT_BOT_NAME } from 'nestjs-telegraf/dist/telegraf.constants';

describe('VoiceService', () => {
  let provider: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        { provide: getBotToken(DEFAULT_BOT_NAME), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => '') } },
      ],
    }).compile();

    provider = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
