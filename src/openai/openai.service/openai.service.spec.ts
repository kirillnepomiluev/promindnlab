import { Test, TestingModule } from '@nestjs/testing';
import { OpenAiService } from './openai.service';
import { ConfigService } from '@nestjs/config';

describe('OpenaiService', () => {
  let provider: OpenAiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiService,
        { provide: ConfigService, useValue: { get: () => 'test-key' } },
      ],
    }).compile();

    provider = module.get<OpenAiService>(OpenAiService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
