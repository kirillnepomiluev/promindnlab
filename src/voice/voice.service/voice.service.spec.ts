import { Test, TestingModule } from '@nestjs/testing';
import { VoiceService } from './voice.service';
import { getBotToken } from 'nestjs-telegraf';
import { ConfigService } from '@nestjs/config';

describe('VoiceService', () => {
  let provider: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        {
          provide: getBotToken(),
          useValue: { telegram: { getFileLink: jest.fn() } },
        },
        { provide: ConfigService, useValue: { get: () => 'key' } },
      ],
    }).compile();

    provider = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
