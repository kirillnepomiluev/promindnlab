import { Test, TestingModule } from '@nestjs/testing';
import { VoiceService } from './voice.service';

describe('VoiceService', () => {
  let provider: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VoiceService],
    }).compile();

    provider = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
